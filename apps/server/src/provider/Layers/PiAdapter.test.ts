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

import { ApprovalRequestId, PiSettings, ThreadId } from "@t3tools/contracts";
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
  const lines = readFileSync(
    join(process.cwd(), "src/provider/pi/__fixtures__", fixtureName),
    "utf8",
  )
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

function makeExtensionRequestPi(request: Record<string, unknown>): string {
  return makeFakePi(`
    import readline from "node:readline";
    const request = ${JSON.stringify(request)};
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const command = JSON.parse(line);
      if (command.type === "get_state") {
        process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "s1", isStreaming: false } }) + "\\n");
        return;
      }
      if (command.type === "prompt") {
        process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }) + "\\n");
        process.stdout.write(JSON.stringify(request) + "\\n");
        return;
      }
      if (command.type === "extension_ui_response") {
        process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "notify-response", method: "notify", message: JSON.stringify(command), notifyType: "info" }) + "\\n");
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
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
      Effect.forkChild,
    );
    const threadId = ThreadId.make("pi-thread-prompt-failure");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hello" });

    const events = [...(yield* Fiber.join(eventsFiber))];
    assert.equal(
      events.some((event) => event.type === "runtime.error"),
      true,
    );
    const turnCompleted = events.find((event) => event.type === "turn.completed");
    assert.ok(turnCompleted);
    assert.equal(turnCompleted.payload.state, "failed");
    assert.equal(turnCompleted.payload.errorMessage, "No API key found");
    const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
    assert.equal(session?.status, "error");
    assert.equal(session?.lastError, "No API key found");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter round-trips Pi confirm requests as approval responses", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter(
      makeSettings(
        makeExtensionRequestPi({
          type: "extension_ui_request",
          id: "confirm-1",
          method: "confirm",
          title: "Allow tool?",
          message: "Run command",
        }),
      ),
    );
    const requestFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
      Effect.forkChild,
    );
    const threadId = ThreadId.make("pi-thread-confirm-request");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "needs confirm" });

    const initialEvents = [...(yield* Fiber.join(requestFiber))];
    const opened = initialEvents.find((event) => event.type === "request.opened");
    assert.ok(opened?.requestId);
    assert.equal(opened.payload.detail, "Allow tool?: Run command");

    const responseFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
      Effect.forkChild,
    );
    yield* adapter.respondToRequest(
      threadId,
      ApprovalRequestId.make(String(opened.requestId)),
      "accept",
    );
    const responseEvents = [...(yield* Fiber.join(responseFiber))];
    const resolved = responseEvents.find((event) => event.type === "request.resolved");
    const notify = responseEvents.find((event) => event.type === "runtime.warning");
    assert.equal(resolved?.payload.decision, "accept");
    assert.ok(String(notify?.payload.message ?? "").includes('"confirmed":true'));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter round-trips Pi input requests as user input responses", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter(
      makeSettings(
        makeExtensionRequestPi({
          type: "extension_ui_request",
          id: "input-1",
          method: "input",
          title: "Project name",
          placeholder: "my-app",
        }),
      ),
    );
    const requestFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
      Effect.forkChild,
    );
    const threadId = ThreadId.make("pi-thread-input-request");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "needs input" });

    const initialEvents = [...(yield* Fiber.join(requestFiber))];
    const requested = initialEvents.find((event) => event.type === "user-input.requested");
    assert.ok(requested?.requestId);
    assert.equal(requested.payload.questions[0]?.header, "Project name");
    assert.equal(requested.payload.questions[0]?.question, "Project name");

    const responseFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
      Effect.forkChild,
    );
    yield* adapter.respondToUserInput(
      threadId,
      ApprovalRequestId.make(String(requested.requestId)),
      {
        "input-1": "titan-ui",
      },
    );
    const responseEvents = [...(yield* Fiber.join(responseFiber))];
    const resolved = responseEvents.find((event) => event.type === "user-input.resolved");
    const notify = responseEvents.find((event) => event.type === "runtime.warning");
    assert.deepEqual(resolved?.payload.answers, { "input-1": "titan-ui" });
    assert.ok(String(notify?.payload.message ?? "").includes('"value":"titan-ui"'));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter maps Pi select and editor requests as user input", () =>
  Effect.gen(function* () {
    const selectAdapter = yield* makePiAdapter(
      makeSettings(
        makeExtensionRequestPi({
          type: "extension_ui_request",
          id: "select-1",
          method: "select",
          title: "Choose mode",
          options: ["fast", "safe"],
        }),
      ),
    );
    const selectFiber = yield* Stream.runCollect(Stream.take(selectAdapter.streamEvents, 5)).pipe(
      Effect.forkChild,
    );
    const selectThreadId = ThreadId.make("pi-thread-select-request");
    yield* selectAdapter.startSession({
      threadId: selectThreadId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    yield* selectAdapter.sendTurn({ threadId: selectThreadId, input: "needs select" });
    const selectEvents = [...(yield* Fiber.join(selectFiber))];
    const selectRequested = selectEvents.find((event) => event.type === "user-input.requested");
    assert.equal(selectRequested?.payload.questions[0]?.multiSelect, false);
    assert.deepEqual(selectRequested?.payload.questions[0]?.options, [
      { label: "fast", description: "fast" },
      { label: "safe", description: "safe" },
    ]);

    const editorAdapter = yield* makePiAdapter(
      makeSettings(
        makeExtensionRequestPi({
          type: "extension_ui_request",
          id: "editor-1",
          method: "editor",
          title: "Edit instructions",
          prefill: "initial text",
        }),
      ),
    );
    const editorFiber = yield* Stream.runCollect(Stream.take(editorAdapter.streamEvents, 5)).pipe(
      Effect.forkChild,
    );
    const editorThreadId = ThreadId.make("pi-thread-editor-request");
    yield* editorAdapter.startSession({
      threadId: editorThreadId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    yield* editorAdapter.sendTurn({ threadId: editorThreadId, input: "needs editor" });
    const editorEvents = [...(yield* Fiber.join(editorFiber))];
    const editorRequested = editorEvents.find((event) => event.type === "user-input.requested");
    assert.equal(editorRequested?.payload.questions[0]?.header, "Edit instructions");
    assert.equal(editorRequested?.payload.questions[0]?.question, "Edit instructions");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter maps source-backed text turn fixtures", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter(makeSettings(makeFixturePi("pi-text-turn.jsonl")));
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 12)).pipe(
      Effect.forkChild,
    );
    const threadId = ThreadId.make("pi-thread-text-fixture");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hello" });

    const events = [...(yield* Fiber.join(eventsFiber))];
    const deltas = events
      .filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      )
      .map((event) => event.payload.delta);
    assert.deepEqual(deltas, ["hello", " world"]);
    const assistantStarted = events.find(
      (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
    );
    const assistantDeltas = events.filter(
      (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
    );
    assert.ok(assistantStarted?.itemId);
    assert.equal(
      assistantDeltas.every((event) => event.itemId === assistantStarted.itemId),
      true,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter maps source-backed bash tool fixtures", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter(makeSettings(makeFixturePi("pi-bash-turn.jsonl")));
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 14)).pipe(
      Effect.forkChild,
    );
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
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 14)).pipe(
      Effect.forkChild,
    );
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

it.effect("PiAdapter maps source-backed file edit tool fixtures", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter(makeSettings(makeFixturePi("pi-file-edit-turn.jsonl")));
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 14)).pipe(
      Effect.forkChild,
    );
    const threadId = ThreadId.make("pi-thread-file-edit-fixture");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "edit file" });

    const events = [...(yield* Fiber.join(eventsFiber))];
    const editStarted = events.find(
      (event) => event.type === "item.started" && event.payload.itemType === "file_change",
    );
    const editDelta = events.find(
      (event) => event.type === "content.delta" && event.payload.streamKind === "command_output",
    );
    const editCompleted = events.find(
      (event) => event.type === "item.completed" && event.payload.itemType === "file_change",
    );
    assert.ok(editStarted?.itemId);
    assert.equal(editDelta?.payload.delta, "Updated README.md");
    assert.equal(editDelta?.itemId, editStarted.itemId);
    assert.equal(editCompleted?.itemId, editStarted.itemId);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter maps source-backed subagent tool fixtures", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter(makeSettings(makeFixturePi("pi-subagent-turn.jsonl")));
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 14)).pipe(
      Effect.forkChild,
    );
    const threadId = ThreadId.make("pi-thread-subagent-fixture");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "ask subagent" });

    const events = [...(yield* Fiber.join(eventsFiber))];
    const subagentStarted = events.find(
      (event) =>
        event.type === "item.started" && event.payload.itemType === "collab_agent_tool_call",
    );
    const subagentDelta = events.find(
      (event) => event.type === "content.delta" && event.payload.streamKind === "command_output",
    );
    const subagentCompleted = events.find(
      (event) =>
        event.type === "item.completed" && event.payload.itemType === "collab_agent_tool_call",
    );
    assert.ok(subagentStarted?.itemId);
    assert.equal(subagentDelta?.payload.delta, "reviewer: looks good");
    assert.equal(subagentDelta?.itemId, subagentStarted.itemId);
    assert.equal(subagentCompleted?.itemId, subagentStarted.itemId);
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
    const exitedFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
      Effect.forkChild,
    );
    const threadId = ThreadId.make("pi-thread-process-exit");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

    const events = [...(yield* Fiber.join(exitedFiber))];
    const exited = events.find((event) => event.type === "session.exited");
    assert.ok(exited);
    assert.equal(exited.payload.exitKind, "error");
    assert.equal(exited.payload.recoverable, true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
