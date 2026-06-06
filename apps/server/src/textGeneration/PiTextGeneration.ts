import { TextGenerationError, type PiSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import type { TextGenerationShape } from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { runPiPrint } from "../provider/pi/PiSystem.ts";

const PI_TEXT_GENERATION_TIMEOUT_MS = 60_000;

function piEnvFromSettings(
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) env[key] = value;
  }
  if (settings.configDir.trim().length > 0) env.PI_CODING_AGENT_DIR = settings.configDir.trim();
  if (settings.sessionDir.trim().length > 0)
    env.PI_CODING_AGENT_SESSION_DIR = settings.sessionDir.trim();
  return env;
}

function piArgsFromSettings(settings: PiSettings): ReadonlyArray<string> {
  const args = ["--print", "--no-session"];
  if (settings.provider.trim().length > 0) args.push("--provider", settings.provider.trim());
  if (settings.model.trim().length > 0) args.push("--model", settings.model.trim());
  if (settings.launchArgs.trim().length > 0) {
    for (const arg of settings.launchArgs.trim().split(/\s+/)) {
      if (arg.length > 0) args.push(arg);
    }
  }
  return args;
}

function doRunPiPrint(input: {
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly prompt: string;
  readonly operation: string;
}): Effect.Effect<string, TextGenerationError> {
  const env = piEnvFromSettings(input.settings, input.environment);
  return Effect.tryPromise({
    try: () =>
      runPiPrint({
        binaryPath: input.settings.binaryPath,
        env,
        cwd: input.cwd,
        args: piArgsFromSettings(input.settings),
        prompt: input.prompt,
        timeoutMs: PI_TEXT_GENERATION_TIMEOUT_MS,
      }),
    catch: (cause) =>
      new TextGenerationError({
        operation: input.operation,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}

function parseJsonObject<T extends object>(text: string): Partial<T> {
  const extracted = extractJsonObject(text);
  if (!extracted || typeof extracted !== "object") return {};
  return extracted as Partial<T>;
}

export function makePiTextGeneration(
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<TextGenerationShape> {
  const generate = (operation: string, cwd: string, prompt: string) =>
    doRunPiPrint({ settings: piSettings, environment, cwd, prompt, operation });

  return Effect.succeed({
    generateCommitMessage: (input) =>
      generate(
        "generateCommitMessage",
        input.cwd,
        buildCommitMessagePrompt({ ...input, includeBranch: input.includeBranch ?? false }).prompt,
      ).pipe(
        Effect.map((text) => {
          const parsed = parseJsonObject<{ subject: string; body: string; branch: string }>(text);
          const subject = sanitizeCommitSubject(
            parsed.subject ?? text.split("\n")[0] ?? "Update code",
          );
          const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
          const branch =
            input.includeBranch && typeof parsed.branch === "string"
              ? sanitizeFeatureBranchName(parsed.branch)
              : undefined;
          return {
            subject,
            body,
            ...(branch ? { branch } : {}),
          };
        }),
      ),
    generatePrContent: (input) =>
      generate("generatePrContent", input.cwd, buildPrContentPrompt(input).prompt).pipe(
        Effect.map((text) => {
          const parsed = parseJsonObject<{ title: string; body: string }>(text);
          return {
            title: sanitizePrTitle(parsed.title ?? text.split("\n")[0] ?? "Update code"),
            body: typeof parsed.body === "string" ? parsed.body.trim() : text,
          };
        }),
      ),
    generateBranchName: (input) =>
      generate("generateBranchName", input.cwd, buildBranchNamePrompt(input).prompt).pipe(
        Effect.map((text) => ({
          branch: sanitizeFeatureBranchName(sanitizeBranchFragment(text)),
        })),
      ),
    generateThreadTitle: (input) =>
      generate("generateThreadTitle", input.cwd, buildThreadTitlePrompt(input).prompt).pipe(
        Effect.map((text) => ({ title: sanitizeThreadTitle(text) })),
      ),
  } satisfies TextGenerationShape);
}
