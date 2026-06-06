# Pi in T3 Code: Merge Plan

## Goal

Make T3 Code the UI for Pi.

Pi stays the agent runtime. T3 becomes the approachable browser/desktop surface where normal users can start Pi sessions, see streaming output, approve actions, use Titan, use skills, and understand what the agent is doing.

```text
User
  -> T3 Code UI
    -> T3 WebSocket API
      -> ProviderService
        -> PiDriver
          -> PiAdapter
            -> PiJsonlRpcClient
              -> pi --mode rpc
                -> Pi tools
                -> Titan memory
                -> skills
                -> extensions
                -> subagents
                -> browser tools
```

## Current State

### Already built

Current uncommitted work in `/Users/mohammadsaad/t3code` adds the first Pi provider skeleton:

```text
packages/contracts/src/settings.ts
packages/contracts/src/model.ts
packages/contracts/src/providerRuntime.ts
apps/server/src/provider/builtInDrivers.ts
apps/server/src/provider/Layers/ProviderRegistry.test.ts
apps/server/src/provider/Drivers/PiDriver.ts
apps/server/src/provider/Layers/PiAdapter.ts
apps/server/src/provider/Layers/PiProvider.ts
apps/server/src/provider/pi/PiJsonlRpcClient.ts
apps/server/src/provider/pi/PiRpcTypes.ts
apps/server/src/provider/pi/PiSystem.ts
apps/server/src/textGeneration/PiTextGeneration.ts
docs/pi-provider-integration-plan.md
```

### Verified facts

- `pi --mode rpc` exists and speaks JSONL over stdin/stdout.
- `get_state` works.
- `get_commands` works and returns extension commands, prompt templates, and skills.
- `get_available_models` works, but returns `data.models`, not a direct array.
- Pi emits startup extension UI events like `setWidget` and `notify`.
- `bun --filter t3 typecheck` passes.
- `bun lint` exits 0 with existing warnings.
- `cd apps/server && bun run test ProviderRegistry` passes: 39 tests.
- root `bun typecheck` currently fails because a web fixture manually lists providers and omits `providers.pi`.

## Scope Decision

Do not merge this as one giant PR claiming Pi is done.

Merge it as a controlled sequence:

1. Provider appears and does not break T3.
2. Pi sessions start/stop safely.
3. Streaming text and tool rendering work.
4. Titan, skills, approvals, and slash commands become easy in the UI.
5. Polish and docs make it usable by normal users.

This keeps Codex, Claude, Cursor, and OpenCode safe while we add Pi.

## Developer Personas

### Primary persona

A builder who already likes terminal agents but wants a better UI:

- wants Pi’s power
- does not want to remember terminal commands
- wants visible session history
- wants approvals and tool output in a clean UI
- wants Titan memory available without thinking about servers/tools

### Secondary persona

A T3 Code user who has never used Pi:

- expects Pi to appear like Codex, Claude, and OpenCode
- wants clear install/auth guidance
- needs errors to explain the fix
- should get value in under 5 minutes

## DX Target

Time to first useful Pi turn should be under 5 minutes.

Champion path:

```text
Install T3
  -> T3 detects Pi if installed
  -> user selects Pi provider
  -> user sends: "say hello"
  -> assistant streams response
  -> user sends: "what do you remember about this repo?"
  -> Titan-backed Pi response appears
```

If Pi is not installed:

```text
Pi unavailable
  -> clear message: "Pi is not installed or not on PATH"
  -> show install command / docs link
  -> settings field for binary path
```

## Architecture Plan

### Provider registration

Pi should be a normal provider driver, not a special case.

```text
BUILT_IN_DRIVERS
  CodexDriver
  ClaudeDriver
  CursorDriver
  OpenCodeDriver
  PiDriver
```

Required files:

```text
apps/server/src/provider/Drivers/PiDriver.ts
apps/server/src/provider/builtInDrivers.ts
packages/contracts/src/model.ts
packages/contracts/src/settings.ts
apps/web/src/components/settings/providerDriverMeta.ts
apps/web/src/components/settings/AddProviderInstanceDialog.tsx
```

### Runtime ownership

One T3 provider session owns one Pi RPC child process.

```text
T3 ThreadId
  -> PiSessionContext
    -> PiJsonlRpcClient
    -> child process: pi --mode rpc
```

Rules:

- start child process on `startSession`
- kill child process on `stopSession`
- reject pending requests on process exit
- never let malformed JSON crash the server
- never let a failed prompt leave the UI stuck in running state

### Protocol boundary

T3 should define a minimal local Pi RPC shape in:

```text
apps/server/src/provider/pi/PiRpcTypes.ts
```

Do not import Pi source types from a global install. T3 must compile without Pi installed.

## Current Blockers

### B1. Root typecheck fails

File:

```text
apps/web/src/components/KeybindingsToast.browser.tsx
```

Problem:

```text
settings.providers manually includes codex, claudeAgent, cursor, opencode, but not pi.
```

Fix:

Add `pi` fixture settings:

```ts
pi: {
  enabled: true,
  binaryPath: "",
  provider: "",
  model: "",
  sessionDir: "",
  configDir: "",
  launchArgs: "",
  customModels: [],
}
```

Then search for other manual `providers: { ... }` fixtures and patch them.

### B2. Pi web metadata missing

File:

```text
apps/web/src/components/settings/providerDriverMeta.ts
```

Fix:

- import `PiSettings`
- import `PiAgentIcon` or pick a simple existing icon
- add Pi to `PROVIDER_CLIENT_DEFINITIONS`

Also remove Pi from coming-soon options in:

```text
apps/web/src/components/settings/AddProviderInstanceDialog.tsx
```

### B3. Model probe shape is wrong

File:

```text
apps/server/src/provider/Layers/PiProvider.ts
```

Actual RPC response:

```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": []
  }
}
```

Current code checks:

```ts
Array.isArray(response.data)
```

Fix:

```ts
if (response.success && response.data && Array.isArray((response.data as any).models)) {
  return (response.data as any).models as PiModelInfo[];
}
```

Then add a unit test so this does not regress.

### B4. Extension UI events are too loosely mapped

Startup events like these should not become user prompts:

```text
extension_ui_request method=setWidget
extension_ui_request method=notify
```

Required mapping:

| Pi method | T3 behavior |
|---|---|
| `confirm` | `request.opened` |
| `select` | `user-input.requested` |
| `input` | `user-input.requested` |
| `editor` | `user-input.requested` with multi-line behavior if supported |
| `notify` | runtime warning/info or toast-shaped event if available |
| `setWidget` | ignore or map to non-blocking provider status |
| `setStatus` | ignore or map to non-blocking provider status |
| `setTitle` | thread metadata update if clean |
| `set_editor_text` | ignore in phase 1 |

### B5. Prompt failure can leave the UI stuck

If Pi returns:

```json
{ "type": "response", "command": "prompt", "success": false, "error": "..." }
```

T3 must emit:

```text
runtime.error
turn.completed state=failed
session.state.changed state=ready or error
```

Do not wait for `turn_end` after prompt preflight failure.

## PR Plan

## PR 1: Compile-safe Pi provider skeleton

Purpose: Pi appears as a provider without breaking existing providers.

Tasks:

- [ ] Fix web settings fixtures with `providers.pi`.
- [ ] Add Pi to browser provider metadata.
- [ ] Remove Pi from coming-soon provider list.
- [ ] Fix `get_available_models` parsing.
- [ ] Add settings decode tests for legacy configs without Pi.
- [ ] Add provider metadata tests if existing patterns support it.
- [ ] Run root checks.

Files:

```text
packages/contracts/src/settings.ts
packages/contracts/src/model.ts
packages/contracts/src/providerRuntime.ts
apps/server/src/provider/builtInDrivers.ts
apps/server/src/provider/Layers/ProviderRegistry.test.ts
apps/server/src/provider/Layers/PiProvider.ts
apps/web/src/components/settings/providerDriverMeta.ts
apps/web/src/components/settings/AddProviderInstanceDialog.tsx
apps/web/src/components/KeybindingsToast.browser.tsx
```

Verification:

```bash
bun typecheck
bun lint
cd apps/server && bun run test ProviderRegistry
```

Exit criteria:

- root typecheck passes
- Pi is registered in provider list
- missing Pi binary does not crash server startup
- existing provider registry behavior remains unchanged

## PR 2: Pi RPC lifecycle and safety

Purpose: T3 can safely start and stop Pi sessions.

Tasks:

- [ ] Add `PiJsonlRpcClient.test.ts`.
- [ ] Test valid response routing by id.
- [ ] Test malformed JSON emits warning event.
- [ ] Test request timeout rejects pending request.
- [ ] Test process exit rejects pending requests.
- [ ] Test `stop()` kills the child process.
- [ ] Make `stop()` idempotent.
- [ ] Make prompt failure finalize the turn and session state.
- [ ] Map `process_exit` to `session.exited` and `runtime.error` when nonzero.

Files:

```text
apps/server/src/provider/pi/PiJsonlRpcClient.ts
apps/server/src/provider/pi/PiJsonlRpcClient.test.ts
apps/server/src/provider/Layers/PiAdapter.ts
apps/server/src/provider/Layers/PiAdapter.test.ts
```

Verification:

```bash
cd apps/server && bun run test PiJsonlRpcClient PiAdapter
bun typecheck
```

Exit criteria:

- no deadlocks on lost responses
- no process leaks on stop
- failed prompt does not leave thread running
- bad Pi output never crashes T3

## PR 3: Streaming text and tool rendering

Purpose: Pi conversations are understandable in T3.

Tasks:

- [ ] Capture successful Pi RPC event fixtures.
- [ ] Update `message_update` text extraction from real payloads.
- [ ] Use stable item ids for assistant messages.
- [ ] Use `toolCallId` as runtime item id for tool lifecycle events.
- [ ] Map bash output to `command_output`.
- [ ] Map edit/write/read tools to file/tool cards.
- [ ] Map Titan tools to `mcp_tool_call` or `dynamic_tool_call` with title `Titan`.
- [ ] Map subagents to `collab_agent_tool_call`.
- [ ] Add event mapping tests from fixtures.

Suggested fixture directory:

```text
apps/server/src/provider/pi/fixtures/
  pi-text-turn.jsonl
  pi-bash-turn.jsonl
  pi-titan-turn.jsonl
  pi-extension-ui.jsonl
```

Verification:

```bash
cd apps/server && bun run test PiAdapter
bun typecheck
```

Manual smoke:

```text
Start Pi thread
Send: say hello and do not edit files
Expected: assistant text streams into T3 timeline

Send: list files with bash
Expected: command card appears with command output

Send: use Titan memory to recall recent T3 Code work
Expected: Titan tool call is visible enough to understand what happened
```

Exit criteria:

- assistant text streams
- tool calls are visible
- Titan usage is visible
- UI does not spam fake prompts from `notify` or `setWidget`

## PR 4: Approvals, input, skills, and commands

Purpose: Pi’s real capabilities become usable from T3.

Tasks:

- [ ] Map `confirm` to T3 approval request.
- [ ] Map `select`, `input`, and `editor` to T3 user-input request.
- [ ] Send `extension_ui_response` with correct Pi request id.
- [ ] Store provider request refs for traceability.
- [ ] Use `get_commands` in Pi provider snapshot.
- [ ] Surface Pi extension commands, prompt templates, and skills in T3 command UI if the existing shape supports it.
- [ ] If command UI integration is awkward, phase it as a searchable Pi command palette later.

Command categories from Pi:

```text
extension command -> slash command
prompt template -> slash command
skill -> skill entry or slash command named skill:<name>
```

Verification:

```text
Trigger a Pi skill that asks a question
T3 shows the question
User answers in T3
Pi receives extension_ui_response
Turn continues
```

Exit criteria:

- approvals do not deadlock
- skills that ask questions work
- commands are discoverable in the T3 UI

## PR 5: User-facing polish and docs

Purpose: a normal user can install, configure, and understand Pi in T3.

Tasks:

- [ ] Add README provider section for Pi.
- [ ] Add docs page: `docs/providers/pi.md`.
- [ ] Add install/auth guidance.
- [ ] Add troubleshooting section.
- [ ] Add Pi provider icon/name polish.
- [ ] Add UI copy for missing binary.
- [ ] Add UI copy for model probe failure.
- [ ] Add manual smoke checklist to docs.

Suggested docs:

```text
# Pi provider

1. Install Pi
2. Confirm `pi --version`
3. Open T3 Code
4. Select Pi provider
5. Send a first prompt
6. Use Titan memory
7. Troubleshooting
```

Best first-run prompt:

```text
Say hello, tell me what tools you have, and do not edit files.
```

Best Titan demo prompt:

```text
Use Titan memory to summarize what we changed recently in this repo.
```

Exit criteria:

- new user understands how to get Pi working
- errors include cause and fix
- Titan is presented as a Pi capability, not a separate T3 dependency

## Detailed Implementation Notes

### Safer launch args

Current code splits `launchArgs` with whitespace. This avoids shell injection because args are passed to `spawn`, not a shell, but it breaks quoted args.

Recommended phase 1:

- keep it simple
- document that args are whitespace split
- do not shell-concatenate
- add tests proving no shell is used

Recommended later:

- replace `launchArgs: string` with `launchArgs: string[]` in settings UI
- or add a small quoted-args parser with tests

### Provider snapshot models

Model slugs should preserve enough provider identity to avoid collisions.

Recommended slug shape:

```text
pi/<provider>/<model-id>
```

If Pi model data only provides `id`, fallback to:

```text
pi/<id>
```

### Text generation

`PiTextGeneration` can stay process-per-call for now.

Reason:

- low architectural risk
- easy timeout behavior
- no shared session lifecycle

Later optimization:

- reuse JSONL RPC client and call `get_last_assistant_text`
- only after core chat lifecycle is stable

### Rollback

Phase 1 should explicitly return unsupported.

Do not fake rollback unless Pi exposes a reliable command.

## Test Matrix

### Unit tests

```text
PiJsonlRpcClient.test.ts
  parses valid JSONL
  routes response by id
  emits events for non-response messages
  emits warning for malformed JSON
  times out unanswered request
  rejects pending requests on exit
  writes exactly one newline per command
  stop is idempotent

PiProvider.test.ts
  missing binary -> unavailable snapshot
  version success -> installed true
  get_available_models data.models -> models populated
  model probe failure -> warning, not crash

PiAdapter.test.ts
  startSession emits started/thread/ready
  sendTurn sends prompt and emits turn.started
  prompt failure emits failed turn and ready/error state
  message_update maps to assistant_text delta
  tool_execution_start/update/end maps to lifecycle events
  extension confirm maps to request.opened
  extension input/select/editor maps to user-input.requested
  notify/setWidget do not block
  interruptTurn sends abort and emits turn.aborted
  stopSession closes process and emits session.exited

PiTextGeneration.test.ts
  builds argv without shell
  includes --print --no-session
  propagates provider/model flags
  timeout returns TextGenerationError
```

### Regression checks

```bash
bun fmt
bun lint
bun typecheck
bun run test
```

### Manual smoke checklist

```text
[ ] Pi appears as provider
[ ] Bad binary path shows unavailable provider, no crash
[ ] Good binary path probes version
[ ] Models appear from Pi RPC
[ ] New Pi thread starts
[ ] Simple assistant text streams
[ ] Bash/tool call renders
[ ] Titan tool call renders
[ ] Skill input prompt works
[ ] Abort stops active turn
[ ] Stop session kills child process
[ ] Existing Codex/Claude/OpenCode flows still work
```

## UX Plan

### First-run surface

Pi provider card states:

```text
Pi
Runs your local Pi agent through T3 Code.
Uses your existing Pi config, tools, Titan memory, skills, and extensions.
```

If missing:

```text
Pi is not installed or not on PATH.
Install Pi, then refresh providers. If Pi is installed elsewhere, set the binary path.
```

If model/auth probe fails:

```text
Pi is installed, but model probing failed.
Run `pi` in a terminal and complete login/model setup, then refresh providers.
```

### Command discoverability

T3 should show Pi capabilities in three levels:

1. provider picker: Pi is available
2. composer command menu: Pi commands and skills are searchable
3. timeline: tools show what Pi did

### Titan in the UI

Titan should not be a separate T3 provider.

Titan should appear as:

- a visible Pi tool call
- a suggested first-run example
- a command/help entry if Pi exposes it through `get_commands`

Good UX copy:

```text
Titan memory is available through Pi. Ask Pi what it remembers, or ask it to search previous work.
```

## Risks

| Risk | User-visible failure | Mitigation |
|---|---|---|
| Pi missing from PATH | provider setup crashes or vanishes | unavailable provider snapshot |
| Pi emits unexpected JSON | T3 server crashes | parse per line and emit warning |
| Prompt preflight fails | UI stuck running | finalize failed turn immediately |
| Tool ids are unstable | timeline cards fragment | use Pi `toolCallId` when present |
| Extension notify becomes prompt | user sees bogus questions | map notify/setWidget separately |
| Child process leak | CPU/memory leak | scope finalizer and stop tests |
| Model response shape changes | empty model list | fixture tests around RPC response |
| Existing providers regress | T3 users lose Codex/Claude/OpenCode | full test suite before merge |

## Final Done Definition

This integration is done when:

- Pi appears in T3 provider list.
- Pi is optional and safe when missing.
- A Pi thread starts from T3.
- Assistant text streams.
- Bash/tool output is visible.
- Titan tool calls are understandable.
- Pi skills that ask for input work.
- Abort works during streaming.
- Stop session kills the Pi child process.
- Pi commands/skills are discoverable enough for normal users.
- README/docs explain setup and troubleshooting.
- `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` pass.

## Recommended Next Command Sequence

```bash
cd /Users/mohammadsaad/t3code

# first fix compile blockers
bun typecheck

# after fixes
bun lint
cd apps/server && bun run test ProviderRegistry
cd ../..
bun run test
```

## GSTACK REVIEW REPORT

### plan-eng-review summary

Verdict: good architecture, not merge-ready.

The core design is right: T3 should wrap Pi through the provider system and Pi should keep owning Titan, tools, skills, extensions, and sessions. The main engineering risk is not architecture. The risk is lifecycle correctness: failed prompts, child process cleanup, request timeouts, event mapping, and extension UI handling.

Recommended engineering stance: merge in small PRs. First make Pi compile and appear safely. Then harden RPC lifecycle. Then improve rendering and UX.

### plan-devex-review summary

Verdict: promising DX, but first-run polish is still missing.

The best product experience is: install T3, select Pi, run a Pi prompt, ask Titan what it remembers. The current skeleton does not yet make that path obvious. Missing binary, auth/model failure, and command discovery need clear UI copy before normal users can succeed without hand-holding.

DX score now: 5/10.

Target after PR 5: 8/10.

What gets it to 8:

- Pi appears like every other T3 provider.
- setup errors say what happened and how to fix it.
- first Pi turn works in under 5 minutes.
- Titan memory is visible as a capability inside Pi.
- skills and commands are searchable from the composer.

### Key decisions

- Pi remains the runtime. T3 is the UI.
- Titan remains inside Pi, not a separate T3 integration.
- Merge as multiple PRs, not one large PR.
- Do not claim feature-complete until approvals, tool rendering, Titan visibility, and child process cleanup are verified.
