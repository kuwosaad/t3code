// @ts-nocheck — Test fixtures create executable fake Pi binaries with Node built-ins.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach } from "vitest";

import { ApprovalRequestId, PiSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { makePiAdapter } from "./PiAdapter.ts";

const assert = NodeAssert;
const join = NodePath.join;
const rmSync = NodeFS.rmSync;
const decodePiSettings = Schema.decodeSync(PiSettings);
const tempDirs: string[] = [];
const FIXTURES_DIR = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../pi/__fixtures__",
);

function makeFakePi(source: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-adapter-test-"));
  tempDirs.push(dir);
  const binary = join(dir, "fake-pi.mjs");
  NodeFS.writeFileSync(binary, `#!/usr/bin/env node\n${source}`);
  NodeFS.chmodSync(binary, 0o755);
  return binary;
}

function makeFixturePi(fixtureName: string): string {
  const lines = NodeFS.readFileSync(NodePath.join(FIXTURES_DIR, fixtureName), "utf8")
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

function makeAckFirstFixturePi(fixtureName: string): string {
  const lines = NodeFS.readFileSync(NodePath.join(FIXTURES_DIR, fixtureName), "utf8")
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
        process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }) + "\\n");
        setTimeout(() => {
          for (const fixtureLine of fixtureLines) {
            process.stdout.write(fixtureLine + "\\n");
          }
        }, 10);
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
        process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "notify-response", method: "notify", message: JSON.stringify(command), notifyType: "warning" }) + "\\n");
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

it.effect("PiAdapter cleans up a session when startup fails", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_state") process.exit(7);
      });
    `);
    const adapter = yield* makePiAdapter(makeSettings(binaryPath));
    const threadId = ThreadId.make("pi-thread-startup-failure");
    const result = yield* Effect.exit(
      adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" }),
    );

    assert.equal(Exit.isFailure(result), true);
    assert.deepEqual(yield* adapter.listSessions(), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter launches the exact provider-aware Pi model selection", () =>
  Effect.gen(function* () {
    const marker = NodePath.join(NodeOS.tmpdir(), `t3-pi-model-args-${Date.now()}.json`);
    const binaryPath = makeFakePi(`
      import * as NodeFS from "node:fs";
      import readline from "node:readline";
      NodeFS.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_state") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "s1", isStreaming: false } }) + "\\n");
        }
      });
    `);
    const adapter = yield* makePiAdapter(makeSettings(binaryPath));
    const threadId = ThreadId.make("pi-thread-model-selection");

    yield* adapter.startSession({
      threadId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "pi/grok/gpt-5.6-luna"),
    });

    assert.deepEqual(JSON.parse(NodeFS.readFileSync(marker, "utf8")), [
      "--mode",
      "rpc",
      "--provider",
      "grok",
      "--model",
      "gpt-5.6-luna",
    ]);
    NodeFS.rmSync(marker, { force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter preserves configured args for legacy unqualified selections", () =>
  Effect.gen(function* () {
    const marker = NodePath.join(NodeOS.tmpdir(), `t3-pi-legacy-model-args-${Date.now()}.json`);
    const binaryPath = makeFakePi(`
      import * as NodeFS from "node:fs";
      import readline from "node:readline";
      NodeFS.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_state") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "s1", isStreaming: false } }) + "\\n");
        }
      });
    `);
    const adapter = yield* makePiAdapter(makeSettings(binaryPath));

    yield* adapter.startSession({
      threadId: ThreadId.make("pi-thread-legacy-model-selection"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "custom-pi-model"),
    });

    assert.deepEqual(JSON.parse(NodeFS.readFileSync(marker, "utf8")), [
      "--mode",
      "rpc",
      "--provider",
      "anthropic",
      "--model",
      "custom-pi-model",
    ]);
    NodeFS.rmSync(marker, { force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter preserves the configured provider for providerless Pi slugs", () =>
  Effect.gen(function* () {
    const marker = NodePath.join(NodeOS.tmpdir(), `t3-pi-providerless-model-${Date.now()}.json`);
    const binaryPath = makeFakePi(`
      import * as NodeFS from "node:fs";
      import readline from "node:readline";
      NodeFS.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_state") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "s1", isStreaming: false } }) + "\\n");
        }
      });
    `);
    const adapter = yield* makePiAdapter(makeSettings(binaryPath));

    yield* adapter.startSession({
      threadId: ThreadId.make("pi-thread-providerless-model-selection"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "pi/custom-model"),
    });

    assert.deepEqual(JSON.parse(NodeFS.readFileSync(marker, "utf8")), [
      "--mode",
      "rpc",
      "--provider",
      "anthropic",
      "--model",
      "custom-model",
    ]);
    NodeFS.rmSync(marker, { force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter rejects a failed get_state response and cleans up", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_state") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "state unavailable" }) + "\\n");
        }
      });
    `);
    const adapter = yield* makePiAdapter(makeSettings(binaryPath));
    const threadId = ThreadId.make("pi-thread-state-failure");
    const result = yield* Effect.exit(
      adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" }),
    );

    assert.equal(Exit.isFailure(result), true);
    assert.deepEqual(yield* adapter.listSessions(), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter ignores successful Pi notify events", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter(
      makeSettings(
        makeExtensionRequestPi({
          type: "extension_ui_request",
          id: "notify-success",
          method: "notify",
          message: "Titan memory ready",
          notifyType: "success",
        }),
      ),
    );
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
      Effect.forkChild,
    );
    const threadId = ThreadId.make("pi-thread-notify-success");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hello" });

    const events = [...(yield* Fiber.join(eventsFiber))];
    assert.equal(
      events.some((event) => event.type === "runtime.warning"),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "runtime.error"),
      false,
    );
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

it.effect("PiAdapter separates PI thinking deltas and ignores agent_settled", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter(
      makeSettings(makeFixturePi("pi-thinking-settled-turn.jsonl")),
    );
    const eventsFiber = yield* Stream.runCollect(
      Stream.takeUntil(adapter.streamEvents, (event) => event.type === "session.exited"),
    ).pipe(Effect.forkChild);
    const threadId = ThreadId.make("pi-thread-thinking-settled");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hello" });

    const events = [...(yield* Fiber.join(eventsFiber))];
    const textDeltas = events
      .filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      )
      .map((event) => event.payload.delta);
    const reasoningDeltas = events
      .filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      )
      .map((event) => event.payload.delta);

    assert.deepEqual(textDeltas, ["visible answer"]);
    assert.deepEqual(reasoningDeltas, ["private reasoning"]);
    assert.equal(
      events.some(
        (event) =>
          event.type === "runtime.warning" && event.payload.detail?.type === "agent_settled",
      ),
      false,
    );
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    assert.equal(events.filter((event) => event.type === "session.exited").length, 1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("PiAdapter writes native RPC events through the provider logger", () =>
  Effect.gen(function* () {
    const writes: Array<{ event: unknown; threadId: unknown }> = [];
    const adapter = yield* makePiAdapter(makeSettings(makeFixturePi("pi-text-turn.jsonl")), {
      nativeEventLogger: {
        filePath: "pi-test.log",
        write: (event, threadId) =>
          Effect.sync(() => {
            writes.push({ event, threadId });
          }),
        close: () => Effect.void,
      },
    });
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 12)).pipe(
      Effect.forkChild,
    );
    const threadId = ThreadId.make("pi-thread-native-log");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hello" });
    yield* Fiber.join(eventsFiber);

    assert.equal(writes.length > 0, true);
    const nativeEvents = writes.map(
      ({ event }) => event as { observedAt?: unknown; event?: Record<string, unknown> },
    );
    assert.equal(typeof nativeEvents[0]?.observedAt, "string");
    assert.equal(
      nativeEvents.some((event) => event.event?.method === "pi.rpc.agent_start"),
      true,
    );
    assert.equal(
      nativeEvents.some((event) => event.event?.method === "pi.rpc.response"),
      true,
    );
    assert.equal(writes[0]?.threadId, threadId);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "PiAdapter maps live-captured text turns when Pi acknowledges the prompt before streaming",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        makeSettings(makeAckFirstFixturePi("pi-live-text-turn.jsonl")),
      );
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 12)).pipe(
        Effect.forkChild,
      );
      const threadId = ThreadId.make("pi-thread-live-text-fixture");

      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const result = yield* adapter.sendTurn({ threadId, input: "hello" });
      assert.equal(result.turnId.length > 0, true);

      const events = [...(yield* Fiber.join(eventsFiber))];
      const delta = events.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      const completed = events.find((event) => event.type === "turn.completed");
      const assistantStarts = events.filter(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      assert.equal(delta?.payload.delta, "OK");
      assert.equal(completed?.payload.state, "completed");
      assert.equal(assistantStarts.length, 1);
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

it.effect("PiAdapter settles an active turn and closes on unexpected process exit", () =>
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
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }) + "\\n");
          setTimeout(() => process.exit(11), 20);
        }
      });
    `);
    const adapter = yield* makePiAdapter(makeSettings(binaryPath));
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 8)).pipe(
      Effect.forkChild,
    );
    const threadId = ThreadId.make("pi-thread-active-process-exit");

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hello" });

    const events = [...(yield* Fiber.join(eventsFiber))];
    assert.equal(events.filter((event) => event.type === "session.exited").length, 1);
    assert.equal(
      events.some((event) => event.type === "runtime.error"),
      true,
    );
    assert.equal(
      events.some((event) => event.type === "turn.completed" && event.payload.state === "failed"),
      true,
    );
    assert.deepEqual(yield* adapter.listSessions(), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
