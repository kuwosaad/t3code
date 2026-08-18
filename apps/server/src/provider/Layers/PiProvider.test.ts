// @ts-nocheck — Test fixtures create executable fake Pi binaries with Node built-ins.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach } from "vitest";

import { PiSettings } from "@t3tools/contracts";
import { checkPiProviderStatus } from "./PiProvider.ts";

const assert = NodeAssert;
const decodePiSettings = Schema.decodeSync(PiSettings);
const tempDirs: string[] = [];

function makeFakePi(source: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-provider-test-"));
  tempDirs.push(dir);
  const binary = NodePath.join(dir, "fake-pi.mjs");
  NodeFS.writeFileSync(binary, `#!/usr/bin/env node\n${source}`);
  NodeFS.chmodSync(binary, 0o755);
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
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

it.effect("PiProvider reports a helpful unavailable status when the Pi binary is missing", () =>
  Effect.gen(function* () {
    const status = yield* checkPiProviderStatus(
      makeSettings("/definitely/missing/pi"),
      process.env,
    ).pipe(Effect.orDie);

    assert.equal(status.installed, false);
    assert.equal(status.status, "error");
    assert.match(status.message ?? "", /Pi CLI was not found/);
    assert.match(status.message ?? "", /full path/);
  }),
);

it.effect("PiProvider does not probe a disabled Pi configuration", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`process.exit(9);`);
    const settings = decodePiSettings({ ...makeSettings(binaryPath), enabled: false });
    const status = yield* checkPiProviderStatus(settings, process.env).pipe(Effect.orDie);

    assert.equal(status.enabled, false);
    assert.equal(status.installed, false);
    assert.equal(status.status, "disabled");
    assert.match(status.message ?? "", /disabled/i);
  }),
);

it.effect("PiProvider leaves the Pi provider default untouched when blank", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`
      if (process.argv.includes("--version")) {
        process.stdout.write("pi 1.2.3\\n");
        process.exit(0);
      }
      if (process.argv.includes("--provider")) process.exit(8);
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: command.type === "get_available_models" ? { models: [] } : { commands: [] } }) + "\\n");
      });
    `);
    const settings = decodePiSettings({ ...makeSettings(binaryPath), provider: "" });
    const status = yield* checkPiProviderStatus(settings, process.env).pipe(Effect.orDie);

    assert.equal(status.installed, true);
    assert.equal(status.status, "ready");
  }),
);

it.effect("PiProvider expands home-relative config and session directories", () =>
  Effect.gen(function* () {
    const marker = NodePath.join(NodeOS.tmpdir(), `t3-pi-provider-env-${Date.now()}.json`);
    const binaryPath = makeFakePi(`
      import * as NodeFS from "node:fs";
      if (process.argv.includes("--version")) {
        NodeFS.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
          config: process.env.PI_CODING_AGENT_DIR,
          session: process.env.PI_CODING_AGENT_SESSION_DIR,
        }));
        process.stdout.write("pi 1.2.3\\n");
        process.exit(0);
      }
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: command.type === "get_available_models" ? { models: [] } : { commands: [] } }) + "\\n");
      });
    `);
    const settings = decodePiSettings({
      ...makeSettings(binaryPath),
      configDir: "~/.pi-test",
      sessionDir: "~/.pi-test/sessions",
    });
    yield* checkPiProviderStatus(settings, process.env).pipe(Effect.orDie);

    const recorded = JSON.parse(NodeFS.readFileSync(marker, "utf8")) as {
      config: string;
      session: string;
    };
    assert.equal(recorded.config, NodePath.join(NodeOS.homedir(), ".pi-test"));
    assert.equal(recorded.session, NodePath.join(NodeOS.homedir(), ".pi-test/sessions"));
    NodeFS.rmSync(marker, { force: true });
  }),
);

it.effect("PiProvider keeps a fallback model and warning status when runtime probing fails", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`
      if (process.argv.includes("--version")) {
        process.stdout.write("pi 1.2.3\\n");
        process.exit(0);
      }
      process.stderr.write("rpc startup failed\\n");
      process.exit(2);
    `);

    const status = yield* checkPiProviderStatus(makeSettings(binaryPath), process.env).pipe(
      Effect.orDie,
    );

    assert.equal(status.installed, true);
    assert.equal(status.status, "warning");
    assert.match(status.message ?? "", /could not read Pi models or commands over RPC/);
    assert.equal(status.models[0]?.slug, "claude-sonnet-4");
  }),
);

it.effect("PiProvider warns when Pi rejects the model probe", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`
      if (process.argv.includes("--version")) {
        process.stdout.write("pi 1.2.3\\n");
        process.exit(0);
      }
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_available_models") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "models unavailable" }) + "\\n");
        }
      });
    `);

    const status = yield* checkPiProviderStatus(makeSettings(binaryPath), process.env).pipe(
      Effect.orDie,
    );

    assert.equal(status.installed, true);
    assert.equal(status.status, "warning");
    assert.equal(status.auth.status, "unknown");
    assert.match(status.message ?? "", /could not read Pi models or commands over RPC/);
  }),
);

it.effect("PiProvider includes probed Pi commands, prompts, and skills as slash commands", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`
      if (process.argv.includes("--version")) {
        process.stdout.write("pi 1.2.3\\n");
        process.exit(0);
      }
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_available_models") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { models: [{ id: "anthropic/claude-sonnet-4" }] } }) + "\\n");
          return;
        }
        if (command.type === "get_commands") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { commands: [
            { name: "memory-sync", description: "Import agent memories", source: "extension" },
            { name: "release-notes", description: "Write release notes", source: "prompt" },
            { name: "skill:titan-memory-workflow", description: "Use Titan memory safely", source: "skill" },
            { name: "memory-sync", description: "Duplicate should be ignored", source: "extension" }
          ] } }) + "\\n");
        }
      });
    `);

    const status = yield* checkPiProviderStatus(makeSettings(binaryPath), process.env).pipe(
      Effect.orDie,
    );

    assert.equal(status.installed, true);
    assert.equal(status.status, "ready");
    assert.deepEqual(status.slashCommands, [
      { name: "memory-sync", description: "Import agent memories" },
      { name: "release-notes", description: "Write release notes" },
      { name: "skill:titan-memory-workflow", description: "Use Titan memory safely" },
    ]);
  }),
);

it.effect("PiProvider keeps duplicate model ids distinct by Pi provider", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`
      if (process.argv.includes("--version")) {
        process.stdout.write("pi 1.2.3\\n");
        process.exit(0);
      }
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_available_models") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { models: [
            { provider: "pi", id: "gpt-5.6-luna" },
            { provider: "grok", id: "gpt-5.6-luna" },
            { provider: "pi", id: "gpt-5.6-luna" }
          ] } }) + "\\n");
          return;
        }
        if (command.type === "get_commands") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { commands: [] } }) + "\\n");
        }
      });
    `);

    const status = yield* checkPiProviderStatus(makeSettings(binaryPath), process.env).pipe(
      Effect.orDie,
    );
    const live = status.models.filter((model) => model.name === "gpt-5.6-luna");

    assert.deepEqual(
      live.map((model) => ({ slug: model.slug, subProvider: model.subProvider })),
      [
        { slug: "pi/pi/gpt-5.6-luna", subProvider: "pi" },
        { slug: "pi/grok/gpt-5.6-luna", subProvider: "grok" },
      ],
    );
  }),
);

it.effect("PiProvider does not duplicate the configured model in the live inventory", () =>
  Effect.gen(function* () {
    const binaryPath = makeFakePi(`
      if (process.argv.includes("--version")) {
        process.stdout.write("pi 1.2.3\\n");
        process.exit(0);
      }
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_available_models") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { models: [
            { provider: "anthropic", id: "claude-sonnet-4" },
            { provider: "grok", id: "claude-sonnet-4" }
          ] } }) + "\\n");
          return;
        }
        if (command.type === "get_commands") {
          process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { commands: [] } }) + "\\n");
        }
      });
    `);
    const status = yield* checkPiProviderStatus(
      { ...makeSettings(binaryPath), model: "anthropic/claude-sonnet-4" },
      process.env,
    ).pipe(Effect.orDie);

    const matching = status.models.filter(
      (model) => model.subProvider === "anthropic" || model.slug === "pi/anthropic/claude-sonnet-4",
    );
    assert.deepEqual(
      matching.map((model) => ({ slug: model.slug, subProvider: model.subProvider })),
      [{ slug: "pi/anthropic/claude-sonnet-4", subProvider: "anthropic" }],
    );
    assert.equal(
      status.models.filter((model) => model.slug === "pi/grok/claude-sonnet-4").length,
      1,
    );
  }),
);
