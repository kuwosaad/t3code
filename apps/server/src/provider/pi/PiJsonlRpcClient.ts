// @ts-nocheck — This file intentionally uses Node.js built-ins (child_process,
// readline, crypto, setTimeout) for the low-level Pi RPC client. Effect's
// ChildProcess / Schedule APIs are designed for single operations; maintaining
// a long-lived JSONL protocol session via those would be far more complex.
// The OpenCode provider similarly delegates process management to its runtime
// layer. For Pi, we keep the RPC client as a self-contained plain-Node class.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import type { PiRpcCommand, PiRpcEvent, PiRpcResponse } from "./PiRpcTypes.ts";
import { isPiRpcResponse } from "./PiRpcTypes.ts";

export class PiRpcClientError extends Error {
  override readonly name = "PiRpcClientError";
  override readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.cause = options?.cause;
  }
}

export interface PiJsonlRpcClientOptions {
  readonly binaryPath: string;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

interface PendingRequest {
  readonly command: string;
  readonly timeoutId: ReturnType<typeof setTimeout>;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: PiRpcClientError) => void;
}

export type PiRpcEventListener = (event: PiRpcEvent) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class PiJsonlRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stderr = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<PiRpcEventListener>();
  private readonly options: PiJsonlRpcClientOptions;
  private stopped = false;

  constructor(options: PiJsonlRpcClientOptions) {
    this.options = options;
  }

  getStderr(): string {
    return this.stderr;
  }

  onEvent(listener: PiRpcEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.child !== null) return Promise.resolve();

    const child = spawn(this.options.binaryPath, ["--mode", "rpc", ...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    child.on("error", (error) => {
      this.rejectAll(new PiRpcClientError(`Failed to start Pi process: ${error.message}`, { cause: error }));
    });

    child.on("exit", (code, signal) => {
      this.child = null;
      this.rejectAll(
        new PiRpcClientError(
          `Pi process exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`,
        ),
      );
      this.emit({
        type: "process_exit",
        code,
        signal,
        stderr: this.stderr,
      });
    });

    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup();
        reject(new PiRpcClientError(`Failed to start Pi process: ${error.message}`, { cause: error }));
      };
      const cleanup = () => child.off("error", onError);
      child.once("error", onError);
      queueMicrotask(() => {
        cleanup();
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (child === null) {
      this.rejectAll(new PiRpcClientError("Pi process is not running."));
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (this.child !== null) {
          this.child.kill("SIGKILL");
        }
        resolve();
      }, 2_000).unref();
    });
  }

  async request<T = unknown>(command: Omit<PiRpcCommand, "id">): Promise<PiRpcResponse<T>> {
    const id = randomUUID();
    const child = this.child;
    if (child === null || !child.stdin.writable) {
      throw new PiRpcClientError("Pi process is not running.");
    }

    const responsePromise = new Promise<PiRpcResponse<T>>((resolve, reject) => {
      const nextTimeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcClientError(`Timed out waiting for Pi RPC response to ${command.type}.`));
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      nextTimeoutId.unref();
      this.pending.set(id, {
        command: command.type,
        timeoutId: nextTimeoutId,
        resolve: resolve as (response: PiRpcResponse) => void,
        reject,
      });
    });

    this.write({ ...command, id } as PiRpcCommand);
    return responsePromise;
  }

  sendExtensionUiResponse(response: {
    readonly id: string;
    readonly value?: string;
    readonly confirmed?: boolean;
    readonly cancelled?: true;
  }): void {
    const payload =
      response.cancelled === true
        ? { type: "extension_ui_response", id: response.id, cancelled: true }
        : typeof response.confirmed === "boolean"
          ? { type: "extension_ui_response", id: response.id, confirmed: response.confirmed }
          : { type: "extension_ui_response", id: response.id, value: response.value ?? "" };
    this.write(payload as PiRpcCommand);
  }

  private write(command: PiRpcCommand): void {
    const child = this.child;
    if (child === null || !child.stdin.writable) {
      throw new PiRpcClientError("Pi process is not running.");
    }
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: PiRpcEvent;
    try {
      parsed = JSON.parse(trimmed) as PiRpcEvent;
    } catch (cause) {
      this.emit({ type: "json_parse_error", line: trimmed, error: String(cause) });
      return;
    }

    if (isPiRpcResponse(parsed) && parsed.id) {
      const pending = this.pending.get(parsed.id);
      if (pending) {
        this.pending.delete(parsed.id);
        clearTimeout(pending.timeoutId);
        pending.resolve(parsed);
        return;
      }
    }

    this.emit(parsed);
  }

  private emit(event: PiRpcEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private rejectAll(error: PiRpcClientError): void {
    if (this.stopped) {
      this.pending.clear();
      return;
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
