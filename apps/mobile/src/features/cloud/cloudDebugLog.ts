import { findErrorTraceId } from "@t3tools/client-runtime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export function isCloudDebugEnabled(): boolean {
  return (
    (typeof __DEV__ !== "undefined" && __DEV__) ||
    (typeof globalThis !== "undefined" &&
      (globalThis as { __T3_CLOUD_DEBUG__?: boolean }).__T3_CLOUD_DEBUG__ === true)
  );
}

export function cloudDebugLog(event: string, data?: Record<string, unknown>): void {
  if (!isCloudDebugEnabled()) {
    return;
  }
  if (data) {
    console.log(`[t3-cloud] ${event}`, data);
  } else {
    console.log(`[t3-cloud] ${event}`);
  }
}

export function traceCloudEffect<A, E, R>(
  event: string,
  data: Record<string, unknown>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const startedAt = performance.now();
    cloudDebugLog(`${event}:start`, data);
    return effect.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          const durationMs = Math.round(performance.now() - startedAt);
          if (Exit.isSuccess(exit)) {
            cloudDebugLog(`${event}:success`, { ...data, durationMs });
            return;
          }
          const error = Cause.squash(exit.cause);
          cloudDebugLog(`${event}:failure`, {
            ...data,
            durationMs,
            message: error instanceof Error ? error.message : String(error),
            traceId: findErrorTraceId(error),
          });
        }),
      ),
    );
  });
}
