// @ts-nocheck — Test fixtures create executable fake Pi binaries with Node built-ins.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function makeFixturePi(fixtureName: string): string {
  const lines = readFileSync(join(process.cwd(), "src/provider/pi/__fixtures__", fixtureName), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return makeFakePi(`
    import readline from "node:readline";
    const fixtureLines = ${JSON.stringify(lines)};
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const command = JSON.parse(line);
      if (command.type === "get_state") {
        process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "s1", isStreaming: false } }) + "\\n");
        return;
      }
      if (command.type === "prompt") {
        for (const fixtureLine of fixtureLines) {
          process.stdout.write(fixtureLine + "\\n");
        }
        process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }) + "\\n");
      }
    });
  `);
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

it.effect("PiAdapter maps source-backed text turn fixtures", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter(makeSettings(makeFixturePi("pi-text-turn.jsonl")));
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 12)).pipe(Effect.forkChild);
    const threadId = ThreadId.make("pi-thread-text-fixture");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hello" });

    const events = [...(yield* Fiber.join(eventsFiber))];
    const deltas = events
      .filter((event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text")
      .map((event) => event.payload.delta);
    assert.deepEqual(deltas, ["hello", " world"]);
    const assistantStarted = events.find(
      (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
    );
    const assistantDeltas = events.filter(
      (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
    );
    assert.ok(assistantStarted?.itemId);
    assert.equal(assistantDeltas.every((event) => event.itemId === assistantStarted.itemId), true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter maps source-backed bash tool fixtures", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter(makeSettings(makeFixturePi("pi-bash-turn.jsonl")));
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 14)).pipe(Effect.forkChild);
    const threadId = ThreadId.make("pi-thread-bash-fixture");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "run bash" });

    const events = [...(yield* Fiber.join(eventsFiber))];
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
    assert.equal(toolDelta?.payload.delta, "ok");
    assert.equal(toolDelta?.itemId, toolStarted.itemId);
    assert.equal(toolCompleted?.itemId, toolStarted.itemId);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter maps source-backed Titan tool fixtures", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter(makeSettings(makeFixturePi("pi-titan-turn.jsonl")));
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 14)).pipe(Effect.forkChild);
    const threadId = ThreadId.make("pi-thread-titan-fixture");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "query titan" });

    const events = [...(yield* Fiber.join(eventsFiber))];
    const titanStarted = events.find(
      (event) => event.type === "item.started" && event.payload.itemType === "mcp_tool_call",
    );
    const titanDelta = events.find(
      (event) => event.type === "content.delta" && event.payload.streamKind === "command_output",
    );
    assert.ok(titanStarted?.itemId);
    assert.equal(titanDelta?.payload.delta, "found 2 memories");
    assert.equal(titanDelta?.itemId, titanStarted.itemId);
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
