// @ts-nocheck — These tests create small executable fixtures with Node built-ins
// to exercise the plain-Node PiJsonlRpcClient process boundary.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, it } from "vitest";

import { PiJsonlRpcClient, PiRpcClientError } from "./PiJsonlRpcClient.ts";

const assert = NodeAssert;
const tempDirs: string[] = [];

function makeFakePi(source: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-rpc-test-"));
  tempDirs.push(dir);
  const binary = NodePath.join(dir, "fake-pi.mjs");
  NodeFS.writeFileSync(binary, `#!/usr/bin/env node\n${source}`);
  NodeFS.chmodSync(binary, 0o755);
  return binary;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("PiJsonlRpcClient", () => {
  it("routes JSONL responses by id and emits non-response events", async () => {
    const binaryPath = makeFakePi(`
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
        process.stdout.write(JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: { ok: true },
        }) + "\\n");
      });
    `);
    const client = new PiJsonlRpcClient({ binaryPath, requestTimeoutMs: 3_000 });
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));

    await client.start();
    const response = await client.request<{ ok: boolean }>({ type: "get_state" });
    await client.stop();

    assert.equal(response.success, true);
    assert.deepEqual(response.data, { ok: true });
    assert.equal((events[0] as { type?: string } | undefined)?.type, "agent_start");
  });

  it("emits a json_parse_error event for malformed stdout lines", async () => {
    const binaryPath = makeFakePi(`
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        process.stdout.write("not-json\\n");
        process.stdout.write(JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
        }) + "\\n");
      });
    `);
    const client = new PiJsonlRpcClient({ binaryPath, requestTimeoutMs: 3_000 });
    const events: Array<{ type?: string }> = [];
    client.onEvent((event) => events.push(event));

    await client.start();
    await client.request({ type: "get_state" });
    await client.stop();

    assert.equal(
      events.some((event) => event.type === "json_parse_error"),
      true,
    );
  });

  it("times out unanswered requests", async () => {
    const binaryPath = makeFakePi(`
      process.stdin.resume();
    `);
    const client = new PiJsonlRpcClient({ binaryPath, requestTimeoutMs: 25 });

    await client.start();
    await assert.rejects(
      () => client.request({ type: "get_state" }),
      (error) => error instanceof PiRpcClientError && error.message.includes("Timed out"),
    );
    await client.stop();
  });

  it("rejects pending requests when the process exits", async () => {
    const binaryPath = makeFakePi(`
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", () => process.exit(7));
    `);
    const client = new PiJsonlRpcClient({ binaryPath, requestTimeoutMs: 3_000 });

    await client.start();
    await assert.rejects(
      () => client.request({ type: "get_state" }),
      (error) => error instanceof PiRpcClientError && error.message.includes("exited with code 7"),
    );
  });
});
