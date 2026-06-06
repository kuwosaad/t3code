import {
  type ModelCapabilities,
  type PiSettings,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  buildServerProvider,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { PiJsonlRpcClient } from "../pi/PiJsonlRpcClient.ts";
import { runPiVersion } from "../pi/PiSystem.ts";
import type { PiModelInfo } from "../pi/PiRpcTypes.ts";

const PROVIDER = ProviderDriverKind.make("pi");

class PiProbeError extends Data.TaggedError("PiProbeError")<{
  readonly detail: string;
}> {}

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "RPC",
  showInteractionModeToggle: true,
} as const;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

// ───── helpers ─────────────────────────────────────────────────────────────

function piEnvFromSettings(settings: PiSettings, environment: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) env[key] = value;
  }
  if (settings.configDir.trim().length > 0) env.PI_CODING_AGENT_DIR = settings.configDir.trim();
  if (settings.sessionDir.trim().length > 0) env.PI_CODING_AGENT_SESSION_DIR = settings.sessionDir.trim();
  return env;
}

function modelSlug(modelId: string): string {
  // Model IDs from Pi look like "anthropic/claude-sonnet-4" — prepend "pi/" for T3 slug
  return modelId.includes("/") ? `pi/${modelId}` : modelId;
}

function nonEmptyProbeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function modelName(modelId: string): string {
  // Extract a display name from the model slug
  const parts = modelId.split("/");
  return parts[parts.length - 1] ?? modelId;
}

function modelsFromPi(input: {
  settings: PiSettings;
  liveModels: ReadonlyArray<PiModelInfo>;
}): ReadonlyArray<ServerProviderModel> {
  const capabilities: ModelCapabilities = {}; // Pi has no option descriptors yet

  const builtIn: ReadonlyArray<ServerProviderModel> = [
    {
      slug: modelSlug(input.settings.model || "anthropic/claude-sonnet-4"),
      name: `Pi (${input.settings.model || "anthropic/claude-sonnet-4"})`,
      isCustom: false,
      capabilities,
    },
    ...input.liveModels.map(
      (m): ServerProviderModel => ({
        slug: modelSlug(m.id),
        name: modelName(m.id),
        isCustom: false,
        capabilities,
      }),
    ),
  ];

  return providerModelsFromSettings(
    builtIn,
    PROVIDER,
    input.settings.customModels,
    capabilities,
  );
}

// ───── model / command probing ─────────────────────────────────────────────

type PiCommandInfo = {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly source?: unknown;
};

type PiRuntimeProbe = {
  readonly models: ReadonlyArray<PiModelInfo>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function parsePiCommands(commands: unknown): ReadonlyArray<ServerProviderSlashCommand> {
  if (!Array.isArray(commands)) return [];
  const byName = new Map<string, ServerProviderSlashCommand>();

  for (const raw of commands) {
    if (!raw || typeof raw !== "object") continue;
    const command = raw as PiCommandInfo;
    const name = nonEmptyProbeString(command.name);
    if (!name) continue;
    const description = nonEmptyProbeString(command.description);
    const key = name.toLowerCase();
    if (byName.has(key)) continue;
    byName.set(key, {
      name,
      ...(description ? { description } : {}),
    });
  }

  return [...byName.values()];
}

async function probePiRuntime(
  settings: PiSettings,
  env: Record<string, string>,
): Promise<PiRuntimeProbe> {
  const client = new PiJsonlRpcClient({
    binaryPath: settings.binaryPath,
    cwd: process.cwd(),
    env,
    args: ["--provider", settings.provider || "anthropic"],
  });
  try {
    await client.start();
    const response = await client.request<{ models?: ReadonlyArray<PiModelInfo> }>({ type: "get_available_models" } as any);
    const models = response.success && response.data && Array.isArray(response.data.models)
      ? response.data.models
      : [];

    let slashCommands: ReadonlyArray<ServerProviderSlashCommand> = [];
    try {
      const commandResponse = await client.request<{ commands?: unknown }>({ type: "get_commands" } as any);
      slashCommands = commandResponse.success ? parsePiCommands(commandResponse.data?.commands) : [];
    } catch {
      slashCommands = [];
    }

    return { models, slashCommands };
  } finally {
    await client.stop();
  }
}

// ───── public API ──────────────────────────────────────────────────────────

export function makePendingPiProvider(settings: PiSettings): Effect.Effect<ServerProviderDraft> {
  return Effect.map(nowIso, (checkedAt) =>
    buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsFromPi({ settings, liveModels: [] }),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi CLI status...",
      },
    }),
  );
}

export function checkPiProviderStatus(
  settings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerProviderDraft> {
  const env = piEnvFromSettings(settings, environment);

  return Effect.gen(function* () {
    const checkedAt = yield* nowIso;

    // ── version probe ──
    const versionExit = yield* Effect.tryPromise({
      try: () => runPiVersion(settings.binaryPath, env),
      catch: (cause) =>
        new PiProbeError({
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.exit);

    if (Exit.isFailure(versionExit)) {
      const detail = versionExit.cause instanceof PiProbeError ? versionExit.cause.detail : "Unknown error";
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: modelsFromPi({ settings, liveModels: [] }),
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: detail.toLowerCase().includes("enoent")
            ? "Pi CLI (`pi`) is not installed or not on PATH."
            : `Failed to execute Pi CLI health check: ${detail}`,
        },
      });
    }

    const version = parseGenericCliVersion(versionExit.value);

    // ── model probe ──
    let liveModels: ReadonlyArray<PiModelInfo> = [];
    let slashCommands: ReadonlyArray<ServerProviderSlashCommand> = [];
    let probeMessage: string | undefined;
    let status: "ready" | "warning" | "error" | "disabled" = "ready";
    let auth: { status: "authenticated" | "unauthenticated" | "unknown"; type?: string } = {
      status: "authenticated",
      type: "cli",
    };

    const modelExit = yield* Effect.tryPromise({
      try: () => probePiRuntime(settings, env),
      catch: (cause) =>
        new PiProbeError({
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.exit);

    if (Exit.isFailure(modelExit)) {
      const detail = modelExit.cause instanceof PiProbeError ? modelExit.cause.detail : "Unknown error";
      status = "warning";
      auth = { status: "unknown", type: "cli" };
      probeMessage = `Pi CLI is installed, but model probing failed: ${detail}`;
    } else {
      liveModels = modelExit.value.models;
      slashCommands = modelExit.value.slashCommands;
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsFromPi({ settings, liveModels }),
      slashCommands,
      probe: {
        installed: true,
        version,
        status,
        auth,
        ...(probeMessage ? { message: probeMessage } : {}),
      },
    });
  });
}
