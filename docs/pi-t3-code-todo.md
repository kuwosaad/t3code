# Pi in T3 Code — Review TODO

## Goal

Make Pi available inside T3 Code as a provider, while keeping Pi as the runtime and T3 as the UI shell.

## Done

- [x] Add `pi` as a provider kind in contracts
- [x] Add `PiSettings` schema
- [x] Add Pi model/provider metadata
- [x] Register `PiDriver` on the server
- [x] Add Pi to the web provider settings UI
- [x] Remove Pi from the hard-coded “coming soon” list
- [x] Add default `providers.pi` config to web fixtures
- [x] Fix Pi model probing to read real RPC shape: `data.models`
- [x] Add settings decode/patch tests for Pi
- [x] Add provider settings form tests for Pi
- [x] Add `PiJsonlRpcClient` tests
- [x] Handle malformed JSON from Pi RPC
- [x] Handle Pi RPC request timeout
- [x] Handle Pi process exit while requests are pending
- [x] Handle Pi prompt `success: false` without leaving UI stuck
- [x] Map unexpected Pi process exit to `session.exited`
- [x] Ignore Pi startup UI events like `setWidget`
- [x] Map Pi `notify` events to runtime warning/error
- [x] Add stable assistant message item IDs
- [x] Add stable tool item IDs
- [x] Add `PiAdapter` lifecycle/streaming tests
- [x] Verify root `bun typecheck`
- [x] Verify `bun lint` passes with existing warnings only
- [x] Verify focused server/web/contracts tests

## Left to build

### PR 3 — Real streaming + tool rendering

- [x] Add source-backed Pi text turn JSONL fixture
- [x] Add source-backed Pi bash/tool turn JSONL fixture
- [x] Add source-backed Pi Titan memory turn JSONL fixture
- [x] Confirm `message_update` text extraction against Pi `assistantMessageEvent.delta`
- [x] Render bash tools as command execution cards
- [x] Render Titan calls as MCP/tool cards
- [x] Add fixture-based mapping tests
- [ ] Capture live Pi JSONL fixtures from a real model run
- [ ] Render file edits as file change cards with fixture coverage
- [ ] Render subagent calls as collaboration agent cards with fixture coverage

### PR 4 — Approvals, inputs, skills, commands

- [ ] Map Pi `confirm` to T3 approval request
- [ ] Map Pi `select` to T3 user input request
- [ ] Map Pi `input` to T3 user input request
- [ ] Map Pi `editor` to T3 user input request
- [ ] Send T3 answers back to Pi as `extension_ui_response`
- [ ] Fetch Pi `get_commands`
- [ ] Surface Pi extension commands in T3 command UI
- [ ] Surface Pi prompt templates in T3 command UI
- [ ] Surface Pi skills as `skill:<name>` commands

### PR 5 — Polish + docs

- [ ] Write `docs/providers/pi.md`
- [ ] Add install/setup guidance
- [ ] Add troubleshooting for missing `pi` binary
- [ ] Add troubleshooting for model probe failures
- [ ] Add first-run example prompts
- [ ] Add Pi smoke-test checklist to docs
- [ ] Improve any rough UI copy

## Manual smoke test before merging broadly

- [ ] T3 starts when `pi` is not installed
- [ ] Pi appears as unavailable when binary is missing
- [ ] Pi appears in provider picker when installed
- [ ] Pi models populate
- [ ] Plain text turn streams correctly
- [ ] Bash/tool call renders correctly
- [ ] Titan memory call is visible
- [ ] Skill requiring user input works
- [ ] Approval prompt works
- [ ] Abort works
- [ ] Stop session kills Pi process
- [ ] Existing providers still work: Codex, Claude, Cursor, OpenCode

## Current verification snapshot

- [x] `bun typecheck`
- [x] `bun lint` — existing warnings only
- [x] `apps/server`: ProviderRegistry + PiJsonlRpcClient + PiAdapter tests
- [x] `apps/web`: ProviderSettingsForm tests
- [x] `packages/contracts`: settings tests
