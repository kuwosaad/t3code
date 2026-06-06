# Pi

Pi support lets T3 Code use Pi as the agent runtime while T3 Code stays the UI.

That means Pi still owns:

- Titan memory
- skills
- extensions
- subagents
- shell and browser tools
- Pi session state

T3 Code only starts Pi, streams Pi events, shows tool cards, and sends approvals or form answers back
to Pi.

## Install Pi

Install Pi first, then confirm the `pi` command works in the same shell that starts the T3 Code
server.

```bash
pi --version
```

If Pi is installed somewhere custom, copy that full path into Settings.

Common default:

```text
Binary path: pi
```

Custom example:

```text
Binary path: /Users/you/.npm-global/bin/pi
```

T3 Code does not bundle Pi. If the binary is missing, T3 Code should still start normally and show
Pi as unavailable.

## Basic Setup

In T3 Code Settings, add or edit a Pi provider:

```text
Display name: Pi
Binary path: pi
Pi model provider: anthropic
Pi model: sonnet:high
Session directory: empty
Config directory: empty
Launch arguments: empty
```

Empty fields use Pi defaults. Start with empty `Session directory`, `Config directory`, and `Launch
arguments` unless you already know you need an override.

## Model Provider And Model

`Pi model provider` maps to Pi's `--provider` flag.

Examples:

```text
anthropic
openai
google
```

`Pi model` maps to Pi's `--model` flag.

Examples:

```text
sonnet:high
anthropic/claude-sonnet-4
```

If these are blank, Pi chooses its normal default model.

## Session And Config Directories

Use these only when you want this T3 Code provider to use a different Pi environment.

```text
Session directory: ~/.pi/agent/sessions
Config directory: ~/.pi/agent
```

`Config directory` is passed to Pi as `PI_CODING_AGENT_DIR`.

`Session directory` is passed to Pi as `PI_CODING_AGENT_SESSION_DIR`.

This is useful for isolated experiments, but most users should leave both empty.

## Skills And Commands

T3 Code asks Pi for commands with `get_commands` during provider status checks.

When Pi reports commands, T3 Code surfaces them in the normal command UI:

- extension commands
- prompt templates
- skills, usually as `skill:<name>` commands

Examples:

```text
/memory-sync
/release-notes
/skill:titan-memory-workflow
```

The command still runs inside Pi. T3 Code is only showing the entry point.

## First-Run Prompts

Try these after Pi appears as ready:

```text
say hello in one sentence
```

```text
use Titan memory to recall what we worked on recently
```

```text
run a safe shell command to show the current git branch
```

```text
use a skill that asks me for input, then continue after I answer
```

These cover plain text streaming, Titan/tool rendering, shell tool rendering, and Pi UI requests.

## Troubleshooting

### Pi Shows As Unavailable

Check the binary path.

```bash
which pi
pi --version
```

If `which pi` finds a path but T3 Code does not, paste the full path into Settings.

Also make sure T3 Code is started from an environment that has the same `PATH` as your terminal.
Desktop launchers often have a smaller `PATH` than interactive shells.

### Model Probe Failed

If Settings says Pi is installed but model probing failed, T3 Code could run `pi --version` but could
not complete Pi's lightweight RPC startup.

Check:

1. Pi works in a terminal.
2. Your model provider credentials are available to Pi.
3. The configured `Pi model provider` is valid.
4. The configured `Config directory` points at the expected Pi config.
5. Extra `Launch arguments` are not disabling model discovery or startup behavior.

A model probe failure should not crash T3 Code. It only means T3 Code falls back to the configured
model and marks the provider with a warning.

### Titan Memory Does Not Show Up

Titan stays inside Pi. Check Pi first:

```bash
pi
```

Then ask Pi directly whether Titan is available, or run the same Titan-memory prompt from T3 Code.
If Pi cannot see Titan in a normal terminal session, T3 Code will not be able to expose it either.

### Skills Or Commands Are Missing

Refresh provider status in Settings.

If commands still do not appear:

1. Confirm the same `Config directory` is used by the Pi provider.
2. Confirm the skill or extension appears in normal Pi.
3. Check whether Pi startup emits warnings.

## Smoke Test Checklist

Before shipping a Pi change broadly, verify:

- T3 Code starts when `pi` is not installed.
- Pi appears as unavailable when the binary is missing.
- Pi appears in the provider picker when installed.
- Pi models populate or the configured fallback model appears.
- Plain text turns stream correctly.
- Bash/tool calls render as command execution cards.
- Titan memory calls are visible as tool cards.
- File edits render as file change cards.
- Subagent calls render as collaboration agent cards.
- Approval prompts work.
- Input/select/editor prompts work.
- Abort stops an active Pi turn.
- Stopping a session kills the Pi child process.
- Existing providers still work: Codex, Claude, Cursor, and OpenCode.
