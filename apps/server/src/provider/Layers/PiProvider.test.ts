// @ts-nocheck — Test fixtures create executable fake Pi binaries with Node built-ins.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach } from "vitest";

import { PiSettings } from "@t3tools/contracts";
import { checkPiProviderStatus } from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const tempDirs: string[] = [];

function makeFakePi(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "t3-pi-provider-test-"));
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
