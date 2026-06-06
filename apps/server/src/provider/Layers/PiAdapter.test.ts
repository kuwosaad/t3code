// @ts-nocheck — Test fixtures create executable fake Pi binaries with Node built-ins.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach } from "vitest";

import { PiSettings, ThreadId } from "@t3tools/contracts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const tempDirs: string[] = [];

function makeFakePi(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "t3-pi-adapter-test-"));
  tempDirs.push(dir);
  const binary = join(dir, "fake-pi.mjs");
  writeFileSync(binary, `#!/usr/bin/env node\n${source}`);
  chmodSync(binary, 0o755);
  return binary;
}

function makeSettings(binaryPath: string): PiSettings {
  return decodePiSettings({
    enabled: true,
    binaryPath,
    provider: "anthropic",
    model: "claude-sonnet-4",
    sessionDir: "",
    configDir: "",
    launchArgs: "",
    customModels: [],
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.effect("PiAdapter finalizes the turn when prompt returns success false", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_state") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "s1", isStreaming: false } }) + "\\n");
          return;
        }
        if (command.type === "prompt") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "No API key found" }) + "\\n");
        }
      });
    `);
    const adapter = yield* makePiAdapter(makeSettings(binaryPath));
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(Effect.forkChild);
    const threadId = ThreadId.make("pi-thread-prompt-failure");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hello" });

    const events = [...(yield* Fiber.join(eventsFiber))];
    assert.equal(events.some((event) => event.type === "runtime.error"), true);
    const turnCompleted = events.find((event) => event.type === "turn.completed");
    assert.ok(turnCompleted);
    assert.equal(turnCompleted.payload.state, "failed");
    assert.equal(turnCompleted.payload.errorMessage, "No API key found");
    const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
    assert.equal(session?.status, "error");
    assert.equal(session?.lastError, "No API key found");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter attaches message and tool deltas to stable item ids", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_state") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "s1", isStreaming: false } }) + "\\n");
          return;
        }
        if (command.type === "prompt") {
          process.stdout.write(JSON.stringify({ type: "message_start" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "message_update", delta: "hello" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "message_end" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "tool_execution_update", toolCallId: "tool-1", stdout: "ok" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "turn_end" }) + "\\n");
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }) + "\\n");
        }
      });
    `);
    const adapter = yield* makePiAdapter(makeSettings(binaryPath));
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 12)).pipe(Effect.forkChild);
    const threadId = ThreadId.make("pi-thread-streaming");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hello" });

    const events = [...(yield* Fiber.join(eventsFiber))];
    const assistantStarted = events.find(
      (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
    );
    const assistantDelta = events.find(
      (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
    );
    assert.ok(assistantStarted?.itemId);
    assert.equal(assistantDelta?.itemId, assistantStarted.itemId);

    const toolStarted = events.find(
      (event) => event.type === "item.started" && event.payload.itemType === "command_execution",
    );
    const toolDelta = events.find(
      (event) => event.type === "content.delta" && event.payload.streamKind === "command_output",
    );
    const toolCompleted = events.find(
      (event) => event.type === "item.completed" && event.payload.itemType === "command_execution",
    );
    assert.ok(toolStarted?.itemId);
    assert.equal(toolDelta?.itemId, toolStarted.itemId);
    assert.equal(toolCompleted?.itemId, toolStarted.itemId);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter maps unexpected process exit to session.exited", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_state") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "s1", isStreaming: false } }) + "\\n");
          setTimeout(() => process.exit(9), 20);
        }
      });
    `);
    const adapter = yield* makePiAdapter(makeSettings(binaryPath));
    const exitedFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(Effect.forkChild);
    const threadId = ThreadId.make("pi-thread-process-exit");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

    const events = [...(yield* Fiber.join(exitedFiber))];
    const exited = events.find((event) => event.type === "session.exited");
    assert.ok(exited);
    assert.equal(exited.payload.exitKind, "error");
    assert.equal(exited.payload.recoverable, true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
