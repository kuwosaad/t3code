# Pi Provider Integration Plan for T3 Code

## Goal

Add Pi as a first-class T3 Code provider so the existing Pi workflow can be used from the T3 UI.

```text
T3 Web UI
  └─ WebSocket
     └─ T3 server ProviderService
        └─ PiDriver
           └─ PiAdapter
              └─ PiJsonlRpcClient
                 └─ child process: pi --mode rpc
                    ├─ Titan tools
                    ├─ gstack skills
                    ├─ Pi extensions
                    └─ existing Pi session storage
```

This must be additive. Codex, Claude, Cursor, and OpenCode behavior must remain unchanged.

## Non-goals

- Do not rewrite T3 Code's provider architecture.
- Do not make Pi a required dependency for T3 Code users.
- Do not import user-local global Pi files at TypeScript compile time.
- Do not change existing provider behavior.
- Do not implement PyAgent until its protocol is known. If PyAgent runs inside Pi as a tool, skill, or extension, it works through this provider automatically.

## Existing facts verified

- T3 Code uses `ProviderDriver` values registered in `apps/server/src/provider/builtInDrivers.ts`.
- A provider instance contains `snapshot`, `adapter`, and `textGeneration` closures.
- T3 Code provider runtime events are defined in `packages/contracts/src/providerRuntime.ts`.
- Server settings currently define built-in schemas in `packages/contracts/src/settings.ts`.
- Pi exposes `pi --mode rpc`, a JSON-lines protocol over stdin/stdout.
- Pi RPC supports `prompt`, `abort`, `new_session`, `get_state`, `set_model`, `get_available_models`, `get_messages`, `get_commands`, extension UI requests, and streaming agent events.

## Safety principles

1. Keep Pi optional. If `pi` is not installed, show Pi as unavailable instead of crashing server startup.
2. Keep existing providers untouched except shared registry/default display additions.
3. Do not compile against the global installed Pi package. Define a minimal local protocol shape in T3 Code.
4. Treat Pi stdout as untrusted JSONL input. Bad lines produce runtime warnings, not process crashes.
5. One Pi child process per T3 provider session. Stop it when the T3 session stops.
6. Preserve Pi's own config, Titan, skills, extensions, and session storage. Do not reimplement them.
7. Tests first for adapter lifecycle, JSONL parsing, event mapping, and missing binary behavior.

## Files to add

```text
apps/server/src/provider/Drivers/PiDriver.ts
apps/server/src/provider/Layers/PiAdapter.ts
apps/server/src/provider/Layers/PiProvider.ts
apps/server/src/provider/pi/PiJsonlRpcClient.ts
apps/server/src/provider/pi/PiRpcTypes.ts
apps/server/src/textGeneration/PiTextGeneration.ts
apps/server/src/provider/Layers/PiAdapter.test.ts
apps/server/src/provider/pi/PiJsonlRpcClient.test.ts
apps/server/src/provider/Layers/PiProvider.test.ts
apps/server/src/textGeneration/PiTextGeneration.test.ts
```

## Files to modify

```text
packages/contracts/src/settings.ts
packages/contracts/src/model.ts
packages/contracts/src/providerRuntime.ts
apps/server/src/provider/builtInDrivers.ts
apps/server/src/provider/ProviderInstanceEnvironment.ts, only if env merge needs a helper
apps/web/src/components/Icons.tsx, optional UI polish only
```

## Settings design

Add `PiSettings` in `packages/contracts/src/settings.ts`:

```ts
export const PiSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
    binaryPath: makeBinaryPathSetting("pi"),
    provider: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    model: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    sessionDir: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    configDir: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    launchArgs: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  },
  { order: ["binaryPath", "provider", "model", "sessionDir", "configDir", "launchArgs"] },
);
```

Meaning:

- `binaryPath`: normally `pi`.
- `provider`: optional Pi provider, for example `anthropic`, `openai`, `google`.
- `model`: optional Pi model pattern, for example `sonnet:high`.
- `sessionDir`: optional `PI_CODING_AGENT_SESSION_DIR` override.
- `configDir`: optional `PI_CODING_AGENT_DIR` override.
- `launchArgs`: escape hatch for extra Pi flags like `--no-skills`, `--extension`, or `--models`.

Modify settings safely:

- Add `providers.pi` with decoding default `{}`.
- Add `PiSettingsPatch` under `ServerSettingsPatch.providers`.
- Add `DEFAULT_MODEL_BY_PROVIDER[pi]`, `DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[pi]`, and `PROVIDER_DISPLAY_NAMES[pi]` in `packages/contracts/src/model.ts`.
- Do not add a required migration. Defaults must decode old settings files unchanged.

## Runtime event contract changes

Add raw sources in `packages/contracts/src/providerRuntime.ts`:

```ts
Schema.Literal("pi.rpc.event"),
Schema.Literal("pi.rpc.response"),
Schema.Literal("pi.rpc.extension_ui_request"),
```

No new canonical event types should be added in phase 1. Map Pi events into existing T3 runtime events.

## Pi JSONL client

Create `apps/server/src/provider/pi/PiJsonlRpcClient.ts`.

Responsibilities:

- Spawn `binaryPath --mode rpc` with optional flags.
- Send one JSON command per line to stdin.
- Read stdout line by line.
- Parse JSON safely.
- Resolve matching `response` messages by `id`.
- Publish non-response messages to an Effect queue or stream.
- Capture stderr for diagnostics.
- Kill the process on scope finalizer.
- Reject pending requests on process exit.
- Enforce request timeouts so a lost response does not deadlock a T3 thread.

Command construction:

```text
pi --mode rpc
  [--provider <provider>]
  [--model <model>]
  [--session-dir <sessionDir>]
  [...launchArgs]
```

Environment construction:

```text
PI_CODING_AGENT_DIR=<configDir>                  if set
PI_CODING_AGENT_SESSION_DIR=<sessionDir>         if set
plus provider instance environment variables
```

Do not shell-concatenate `launchArgs`. Parse using the existing shared CLI argument parser if available, or reject unsafe unparsed strings and switch `launchArgs` to an array before implementation.

## PiAdapter design

Create `apps/server/src/provider/Layers/PiAdapter.ts`.

Adapter state:

```ts
Map<ThreadId, {
  client: PiJsonlRpcClient;
  session: ProviderSession;
  activeTurnId?: TurnId;
  events: Queue<ProviderRuntimeEvent>;
}>
```

Methods:

- `startSession(input)`
  - Create a new Pi RPC client for the thread.
  - Start the process.
  - Send `get_state` to verify readiness.
  - Emit `session.started`, `thread.started`, `session.state.changed: ready`.
  - Return `ProviderSession` with `provider = pi`, `providerInstanceId`, `runtimeMode`, `cwd`, `model`, `threadId`, and `createdAt`.

- `sendTurn(input)`
  - Generate a T3 `TurnId`.
  - Emit `turn.started` and `session.state.changed: running`.
  - Send Pi `prompt` with input text and supported image attachments.
  - Return `{ threadId, turnId }` immediately.
  - Completion is driven by Pi `agent_end` or `turn_end` events.

- `interruptTurn(threadId, turnId)`
  - Send Pi `abort`.
  - Emit `turn.aborted` and `session.state.changed: ready` when acknowledged.

- `respondToRequest` and `respondToUserInput`
  - Map T3 approval or user input responses to Pi `extension_ui_response` lines.
  - Store the original Pi extension request id in `providerRefs.providerRequestId`.

- `stopSession(threadId)`
  - Stop the Pi client.
  - Emit `session.exited` and remove state.

- `listSessions`, `hasSession`, `stopAll`
  - Pure state operations.

- `readThread`
  - Send Pi `get_messages`.
  - Convert to a best-effort `ProviderThreadSnapshot`.
  - Phase 1 can return only turns/items needed by T3's current UI if rollback is unsupported.

- `rollbackThread`
  - Phase 1: return a provider adapter error saying Pi rollback is unsupported unless Pi exposes a reliable command.

- `streamEvents`
  - Merge all per-session event queues into a single stream.

## Event mapping

Map Pi RPC and agent events to existing T3 events:

| Pi event | T3 event |
|---|---|
| process started | `session.started` |
| `get_state` success | `session.configured` |
| `agent_start` or `turn_start` | `session.state.changed: running`, `turn.started` |
| `message_start` assistant | `item.started` with `assistant_message` |
| `message_update` assistant delta | `content.delta` with `assistant_text` |
| `message_end` assistant | `item.completed` |
| `tool_execution_start` for bash | `item.started` with `command_execution` |
| `tool_execution_update` | `content.delta` with `command_output` |
| `tool_execution_end` | `item.completed` |
| `tool_call` read/write/edit/bash | matching tool lifecycle item when possible, otherwise `dynamic_tool_call` |
| `tool_result` | `content.delta` or `item.completed` |
| `compaction_start` | `item.started` with `context_compaction` |
| `compaction_end` | `item.completed` |
| `turn_end` or `agent_end` | `turn.completed`, `session.state.changed: ready` |
| `extension_ui_request` confirm/select/input/editor | `request.opened` or `user-input.requested` |
| `extension_error` | `runtime.error` |
| JSON parse error | `runtime.warning` |
| process exit nonzero | `session.exited` with `exitKind: error` and `runtime.error` |

Every mapped event must include:

- `eventId`
- `provider = ProviderDriverKind.make("pi")`
- `providerInstanceId`
- `threadId`
- `turnId` when available
- `createdAt`
- `raw` with the original Pi event

## PiProvider snapshot

Create `apps/server/src/provider/Layers/PiProvider.ts`.

Health check behavior:

1. Run `pi --version` with timeout.
2. If command missing, return installed false, status error, auth unknown.
3. If version works, run `pi --mode rpc`, send `get_available_models`, then stop.
4. If models are returned, status ready and auth authenticated.
5. If model probe fails due API/auth error, status error with clear message.

Use `buildServerProvider` from `providerSnapshot.ts`.

Presentation:

```ts
presentation: {
  displayName: "Pi",
  badgeLabel: "RPC",
  showInteractionModeToggle: true,
}
```

Models:

- Prefer live `get_available_models` results.
- Fallback to configured `model` if present.
- Final fallback to one generic `default` model so UI remains usable.

Skills and slash commands:

- Use Pi `get_commands` and map skill/prompt/extension commands to T3 `slashCommands` or `skills` if existing snapshot shapes support it.
- If not needed for phase 1, defer command palette integration and keep chat slash commands as plain prompt text.

## PiDriver

Create `apps/server/src/provider/Drivers/PiDriver.ts`.

It mirrors `OpenCodeDriver.ts`:

- `driverKind = ProviderDriverKind.make("pi")`
- metadata display name `Pi`
- `supportsMultipleInstances: true`
- config schema `PiSettings`
- default config decodes `{}`
- merge provider instance environment
- build adapter with `makePiAdapter`
- build text generation with `makePiTextGeneration`
- build snapshot with `makeManagedServerProvider`
- stamp `instanceId`, `driver`, `displayName`, `accentColor`, and continuation group

Register in `apps/server/src/provider/builtInDrivers.ts`:

```ts
import { PiDriver, type PiDriverEnv } from "./Drivers/PiDriver.ts";

export type BuiltInDriversEnv =
  | ClaudeDriverEnv
  | CodexDriverEnv
  | CursorDriverEnv
  | OpenCodeDriverEnv
  | PiDriverEnv;

export const BUILT_IN_DRIVERS = [
  CodexDriver,
  ClaudeDriver,
  CursorDriver,
  OpenCodeDriver,
  PiDriver,
];
```

## Pi text generation

Create `apps/server/src/textGeneration/PiTextGeneration.ts`.

Phase 1 implementation:

- Use `pi --print --no-session` for branch names, commit messages, and PR summaries.
- Pass a concise system prompt if the text generation API supports it.
- Use the configured provider/model if present.
- Apply strict timeout.
- On failure, return a typed text generation error, not a thrown defect.

Alternative later:

- Reuse the JSONL client and call `prompt`, then `get_last_assistant_text`.
- This avoids process-per-generation but adds lifecycle complexity. Defer until phase 1 works.

## Test plan

### Unit tests

`PiJsonlRpcClient.test.ts`

- Parses valid JSONL responses.
- Routes response by id.
- Emits non-response events to the stream.
- Ignores or warns on malformed JSON lines.
- Rejects pending requests when process exits.
- Times out unanswered requests.
- Writes commands with exactly one trailing newline.

`PiAdapter.test.ts`

- `startSession` starts client and emits session/thread ready events.
- `sendTurn` sends Pi `prompt` and emits `turn.started`.
- Pi `message_update` becomes T3 `content.delta`.
- Pi `tool_execution_start/update/end` becomes item lifecycle plus command output.
- Pi `extension_ui_request` becomes T3 approval or user input request.
- `respondToRequest` sends the correct `extension_ui_response`.
- `interruptTurn` sends `abort` and emits aborted state.
- `stopSession` closes process and removes state.
- Unknown Pi events become `runtime.warning`, not crashes.

`PiProvider.test.ts`

- Missing binary returns unavailable snapshot.
- `pi --version` success returns installed true with parsed version.
- Model probe success populates models.
- Model probe auth failure shows clear unavailable/error message.

`PiTextGeneration.test.ts`

- Builds safe argv without shell interpolation.
- Uses `--print --no-session`.
- Propagates provider/model flags.
- Timeout returns typed error.

### Integration smoke test

Manual command sequence after implementation:

```bash
cd /Users/mohammadsaad/t3code
bun install .
bun typecheck
bun lint
bun run test --filter=Pi
bun dev
```

Then in the UI:

1. Confirm Pi appears as a provider.
2. Confirm unavailable state if `binaryPath` is wrong.
3. Set `binaryPath` back to `pi`.
4. Start a thread with Pi.
5. Send `Say hello and do not edit files`.
6. Confirm assistant text streams.
7. Send `List files with bash`.
8. Confirm command/tool output renders.
9. Trigger a skill that asks for input if available.
10. Confirm T3 shows a request and response works.
11. Stop session and verify child process exits.

### Regression commands before completion

```bash
bun fmt
bun lint
bun typecheck
bun run test
```

Do not run only Pi tests before claiming done. Existing provider tests must still pass.

## Rollout plan

### Phase 0: Protocol spike

- Add a tiny throwaway script or test fixture that spawns `pi --mode rpc`.
- Send `get_state`, `get_available_models`, and one simple `prompt`.
- Capture real events from Pi.
- Update event mapping table with exact payload shapes.

Exit criteria:

- We know exact event payloads for assistant text, tool calls, and extension UI.

### Phase 1: Hidden provider behind code only

- Add settings schema, driver, adapter, client, snapshot, and text generation.
- Register driver.
- Keep UI generic. No custom icon required.
- Tests pass.

Exit criteria:

- Pi appears in provider list.
- A simple text-only Pi conversation works.
- Existing provider tests pass.

### Phase 2: Tool rendering and approvals

- Complete event mapping for read/edit/write/bash/subagent/browser/Titan tools.
- Complete extension UI request handling.
- Add tests for each high-value tool event type.

Exit criteria:

- Titan tool calls are visible enough in T3.
- gstack skills that ask questions do not deadlock.
- Abort works while Pi is streaming.

### Phase 3: Polish

- Add Pi icon/name polish if needed.
- Surface Pi slash commands and skills in T3 command UI if T3 snapshot supports it cleanly.
- Add docs for configuring Pi provider instances.

Exit criteria:

- Normal daily Pi workflow is usable from T3 UI.

## Breakage risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Pi missing from PATH | T3 server could crash if not handled | Probe returns unavailable snapshot, no throw |
| Bad Pi JSON line | Runtime crash | Parse per line with try/catch and emit warning |
| Pi event payload changes | UI renders wrong events | Keep raw event attached and test known mappings |
| Request without response | Thread hangs | Per-request timeout and pending rejection on exit |
| Abort race | Turn remains running in UI | Emit local aborted event after successful `abort` response |
| Child process leak | CPU/memory leak | Scope finalizer kills process and tests verify stop |
| Existing settings decode break | Users cannot start T3 | All Pi fields decoding-default optional |
| Existing provider regression | Codex/Claude broken | Run full `bun run test`, not Pi-only tests |
| Shell injection via launch args | Security issue | Never shell-concatenate args; parse or remove launchArgs |
| Titan or skill prompts block | User stuck | Map `extension_ui_request` in phase 2 before calling feature complete |

## What already exists and should be reused

- `ProviderDriver` SPI in `apps/server/src/provider/ProviderDriver.ts`.
- Managed snapshots via `makeManagedServerProvider`.
- Provider snapshot helpers in `providerSnapshot.ts`.
- Provider instance environment merging.
- OpenCode driver shape for a close implementation template.
- Existing runtime event schemas instead of adding Pi-specific UI events.
- Pi's own RPC mode, Titan integration, skills, extensions, and session persistence.

## NOT in scope for first PR

- PyAgent standalone provider. Needs protocol discovery first.
- Full rollback support. Pi RPC does not expose a clear rollback command in the verified type surface.
- Perfect rendering for every Pi event. Phase 1 focuses on chat, tools, stop, and errors.
- Upstream plugin architecture for arbitrary local agents.
- Moving Titan into T3. Titan remains inside Pi and is accessed through Pi tools.

## Implementation tasks

- [ ] T1 (P1) Add Pi settings and model defaults.
  - Files: `packages/contracts/src/settings.ts`, `packages/contracts/src/model.ts`.
  - Verify: settings decode tests and typecheck.

- [ ] T2 (P1) Add Pi raw runtime sources.
  - Files: `packages/contracts/src/providerRuntime.ts`.
  - Verify: provider runtime schema tests.

- [ ] T3 (P1) Implement local Pi JSONL RPC client.
  - Files: `apps/server/src/provider/pi/PiJsonlRpcClient.ts`, `PiRpcTypes.ts`.
  - Verify: client unit tests for parsing, request routing, timeout, malformed JSON, process exit.

- [ ] T4 (P1) Implement PiAdapter lifecycle and core event mapping.
  - Files: `apps/server/src/provider/Layers/PiAdapter.ts`.
  - Verify: adapter unit tests for start, send, stream, abort, stop.

- [ ] T5 (P1) Implement PiProvider health snapshot.
  - Files: `apps/server/src/provider/Layers/PiProvider.ts`.
  - Verify: missing binary and model probe tests.

- [ ] T6 (P1) Implement PiDriver and register it.
  - Files: `apps/server/src/provider/Drivers/PiDriver.ts`, `apps/server/src/provider/builtInDrivers.ts`.
  - Verify: registry tests show Pi available/unavailable without affecting other drivers.

- [ ] T7 (P2) Implement Pi text generation.
  - Files: `apps/server/src/textGeneration/PiTextGeneration.ts`.
  - Verify: argv construction and timeout tests.

- [ ] T8 (P2) Add extension UI request mapping.
  - Files: `PiAdapter.ts`.
  - Verify: confirm/select/input/editor request tests.

- [ ] T9 (P2) Manual UI smoke test.
  - Verify: Pi provider appears, starts a thread, streams text, shows tool output, aborts, stops cleanly.

- [ ] T10 (P1) Full regression check.
  - Commands: `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`.

## Sequential execution recommendation

This should be mostly sequential because adapter, driver, and provider contracts touch shared provider architecture.

Parallel-safe split if using worktrees:

```text
Lane A: contracts/settings/model/providerRuntime
Lane B: PiJsonlRpcClient with tests
After A+B merge:
Lane C: PiAdapter + PiProvider + PiDriver
Lane D: text generation + UI polish
Final: full regression suite
```

Avoid implementing `PiAdapter` before the Phase 0 protocol spike. The event mapping needs real Pi payloads, not guesses.

## Done definition

The integration is done when:

- Pi appears in T3 provider list.
- Missing Pi binary shows unavailable provider, not a crash.
- A Pi thread can start from the T3 UI.
- Assistant text streams into T3.
- Bash/tool execution is visible enough to understand what Pi did.
- Abort stops an active Pi turn.
- Session stop kills the child process.
- Titan and gstack skills remain loaded because Pi starts through its normal runtime.
- `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` pass.
