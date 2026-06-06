import {
  ApprovalRequestId,
  EventId,
  type PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { PiJsonlRpcClient } from "../pi/PiJsonlRpcClient.ts";
import { isPiExtensionUiRequest, type PiExtensionUiRequest, type PiRpcEvent } from "../pi/PiRpcTypes.ts";

const PROVIDER = ProviderDriverKind.make("pi");

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

interface PiSessionContext {
  session: ProviderSession & Record<string, unknown>;
  readonly client: PiJsonlRpcClient;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly pendingRequests: Map<string, { piRequestId: string; requestId: RuntimeRequestId }>;
  readonly activeToolItemIds: Map<string, RuntimeItemId>;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
  activeTurnId: TurnId | undefined;
  activeAssistantItemId: RuntimeItemId | undefined;
}

// ───── helpers ─────────────────────────────────────────────────────────────

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function piArgsFromSettings(settings: PiSettings): ReadonlyArray<string> {
  const args: string[] = [];
  if (settings.provider.trim().length > 0) args.push("--provider", settings.provider.trim());
  if (settings.model.trim().length > 0) args.push("--model", settings.model.trim());
  if (settings.sessionDir.trim().length > 0) args.push("--session-dir", settings.sessionDir.trim());
  if (settings.launchArgs.trim().length > 0) {
    for (const arg of settings.launchArgs.trim().split(/\s+/)) {
      if (arg.length > 0) args.push(arg);
    }
  }
  return args;
}

function piEnvFromSettings(settings: PiSettings, environment: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) env[key] = value;
  }
  if (settings.configDir.trim().length > 0) env.PI_CODING_AGENT_DIR = settings.configDir.trim();
  if (settings.sessionDir.trim().length > 0) env.PI_CODING_AGENT_SESSION_DIR = settings.sessionDir.trim();
  return env;
}

function textFromRecord(value: Record<string, unknown>): string {
  for (const key of ["assistantMessageEvent", "partialResult", "result"] as const) {
    if (value[key] && typeof value[key] === "object") return textFromRecord(value[key] as Record<string, unknown>);
  }

  for (const key of ["text", "delta", "output", "stdout", "stderr"] as const) {
    if (typeof value[key] === "string") return value[key] as string;
  }

  if (Array.isArray(value.content)) return (value.content as any[]).map(textFromUnknown).join("");
  if (value.message && typeof value.message === "object") return textFromRecord(value.message as Record<string, unknown>);
  return "";
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return textFromRecord(value as Record<string, unknown>);
}

function toolNameFromEvent(event: PiRpcEvent): string {
  const record = event as Record<string, unknown>;
  for (const key of ["toolName", "tool", "name"] as const) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "tool";
}

function toolKeyFromEvent(event: PiRpcEvent): string {
  const record = event as Record<string, unknown>;
  for (const key of ["toolCallId", "toolUseId", "callId", "id"] as const) {
    if (typeof record[key] === "string" && (record[key] as string).length > 0) return record[key] as string;
  }
  return toolNameFromEvent(event);
}

function toolItemType(toolName: string) {
  const nl = toolName.toLowerCase();
  if (nl.includes("bash")) return "command_execution" as const;
  if (nl.includes("edit") || nl.includes("write") || nl.includes("patch") || nl.includes("multiedit")) return "file_change" as const;
  if (nl.includes("mcp") || nl.includes("titan")) return "mcp_tool_call" as const;
  if (nl.includes("agent") || nl.includes("subagent")) return "collab_agent_tool_call" as const;
  if (nl.includes("web") || nl.includes("search")) return "web_search" as const;
  if (nl.includes("image")) return "image_view" as const;
  return "dynamic_tool_call" as const;
}

function ensureContext(
  sessions: ReadonlyMap<ThreadId, PiSessionContext>,
  threadId: ThreadId,
): PiSessionContext {
  const context = sessions.get(threadId);
  if (!context) throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  if (Ref.getUnsafe(context.stopped)) throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
  return context;
}

// ───── main factory ────────────────────────────────────────────────────────

export function makePiAdapter(
  piSettings: PiSettings,
  options?: PiAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const crypto = yield* Crypto.Crypto;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Pi runtime identifier.",
            cause,
          }),
      ),
    );

    type EventBaseInput = {
      readonly threadId: ThreadId;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly createdAt?: string | undefined;
      readonly raw?: unknown;
    };

    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? { raw: { source: "pi.rpc.event" as const, payload: input.raw } }
            : {}),
        })),
      );

    // Layer-level finalizer — stops all sessions on layer shutdown
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) => stopPiContext(context).pipe(Effect.ignoreCause),
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    // ── session helpers ────────────────────────────────────────────────────

    function updateSession(
      context: PiSessionContext,
      patch: Partial<ProviderSession>,
      options?: {
        readonly clearActiveTurnId?: boolean;
        readonly clearLastError?: boolean;
      },
    ): Effect.Effect<ProviderSession> {
      return Effect.gen(function* () {
        const updatedAtVal = yield* nowIso;
        const merged = { ...context.session, ...patch, updatedAt: updatedAtVal };
        const mutable = merged as Record<string, unknown>;
        if (options?.clearActiveTurnId) delete mutable.activeTurnId;
        if (options?.clearLastError) delete mutable.lastError;
        context.session = mutable as unknown as ProviderSession & Record<string, unknown>;
        return context.session as unknown as ProviderSession;
      });
    }

    const stopPiContext = Effect.fn("stopPiContext")(function* (context: PiSessionContext) {
      if (yield* Ref.getAndSet(context.stopped, true)) return false;
      sessions.delete(context.session.threadId as unknown as ThreadId);
      yield* Effect.promise(() => context.client.stop()).pipe(Effect.ignore);
      yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
      return true;
    });

    const failActiveTurn = Effect.fn("failActiveTurn")(function* (
      context: PiSessionContext,
      detail: string,
      raw?: unknown,
    ) {
      const threadId = context.session.threadId as unknown as ThreadId;
      const turnId = context.activeTurnId;
      if (turnId) {
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId, raw })),
          type: "runtime.error" as const,
          payload: { message: detail, class: "provider_error" as const, detail: raw },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId, raw })),
          type: "turn.completed" as const,
          payload: { state: "failed" as const, stopReason: null, errorMessage: detail },
        });
      } else {
        yield* emit({
          ...(yield* buildEventBase({ threadId, raw })),
          type: "runtime.error" as const,
          payload: { message: detail, class: "provider_error" as const, detail: raw },
        });
      }
      context.activeTurnId = undefined;
      yield* updateSession(
        context,
        { status: "error" as const, lastError: detail },
        { clearActiveTurnId: true },
      );
      yield* emit({
        ...(yield* buildEventBase({ threadId, raw })),
        type: "session.state.changed" as const,
        payload: { state: "error" as const, reason: detail },
      });
    });

    const completeActiveTurn = Effect.fn("completeActiveTurn")(function* (
      context: PiSessionContext,
      raw?: unknown,
    ) {
      const threadId = context.session.threadId as unknown as ThreadId;
      const tid = context.activeTurnId;
      if (tid) {
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: tid, raw })),
          type: "turn.completed" as const,
          payload: { state: "completed" as const, stopReason: null },
        });
      }
      context.activeTurnId = undefined;
      yield* updateSession(context, { status: "ready" as const }, { clearActiveTurnId: true, clearLastError: true });
      yield* emit({
        ...(yield* buildEventBase({ threadId, raw })),
        type: "session.state.changed" as const,
        payload: { state: "ready" as const },
      });
    });

    // ── event handlers ─────────────────────────────────────────────────────

    const handleExtensionRequest = Effect.fn("handleExtensionRequest")(function* (
      context: PiSessionContext,
      event: PiExtensionUiRequest,
    ) {
      const threadId = context.session.threadId as unknown as ThreadId;
      if (event.method === "setWidget" || event.method === "setStatus" || event.method === "setTitle" || event.method === "set_editor_text") {
        return;
      }

      if (event.method === "notify") {
        yield* emit({
          ...(yield* buildEventBase({ threadId, raw: event })),
          type: event.notifyType === "error" ? "runtime.error" as const : "runtime.warning" as const,
          payload: {
            message: event.message,
            ...(event.notifyType ? { detail: { notifyType: event.notifyType } } : {}),
          },
        });
        return;
      }

      const requestId = RuntimeRequestId.make(event.id);
      context.pendingRequests.set(event.id, { piRequestId: event.id, requestId });

      // title is present on select/confirm/input/editor, but not on notify
      const evTitle = (event as Record<string, unknown>).title as string | undefined;
      if (event.method === "confirm") {
        yield* emit({
          ...(yield* buildEventBase({ threadId, requestId: event.id, raw: event })),
          type: "request.opened" as const,
          payload: {
            requestType: "dynamic_tool_call" as const,
            detail: `${evTitle ?? ""}: ${(event as Record<string, unknown>).message ?? ""}`,
            args: event,
          },
        });
      } else {
        yield* emit({
          ...(yield* buildEventBase({ threadId, requestId: event.id, raw: event })),
          type: "user-input.requested" as const,
          payload: {
            questions: [{
              id: event.id,
              header: evTitle ?? "Input",
              question: evTitle ?? "",
              options: event.method === "select"
                ? (event as Record<string, unknown>).options
                  ? ((event as Record<string, unknown>).options as string[]).map((o: string) => ({ label: o, description: o }))
                  : [{ label: "value", description: "Value" }]
                : [{ label: "value", description: "Value" }],
              ...(event.method === "select" ? { multiSelect: false } : {}),
            }],
          },
        });
      }
    });

    const handlePiEvent = Effect.fn("handlePiEvent")(function* (
      context: PiSessionContext,
      event: PiRpcEvent,
    ) {
      if (yield* Ref.get(context.stopped)) return;

      const threadId = context.session.threadId as unknown as ThreadId;
      const turnId = context.activeTurnId;

      if (isPiExtensionUiRequest(event)) {
        yield* handleExtensionRequest(context, event);
        return;
      }

      const evType = typeof (event as Record<string, unknown>).type === "string"
        ? (event as Record<string, unknown>).type as string
        : "unknown";

      switch (evType) {
        case "agent_start":
        case "turn_start":
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "session.state.changed",
            payload: { state: "running" },
          });
          break;

        case "message_start": {
          const itemId = RuntimeItemId.make(`pi-msg-${(yield* randomUUIDv4).slice(0, 8)}`);
          context.activeAssistantItemId = itemId;
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, itemId: String(itemId), raw: event })),
            type: "item.started" as const,
            payload: { itemType: "assistant_message" as const, status: "inProgress" as const, title: "Pi" },
          });
          break;
        }

        case "message_update": {
          const delta = textFromUnknown(event);
          if (delta.length > 0) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId,
                turnId,
                itemId: context.activeAssistantItemId ? String(context.activeAssistantItemId) : undefined,
                raw: event,
              })),
              type: "content.delta" as const,
              payload: { streamKind: "assistant_text" as const, delta },
            });
          }
          break;
        }

        case "message_end":
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: context.activeAssistantItemId ? String(context.activeAssistantItemId) : undefined,
              raw: event,
            })),
            type: "item.completed" as const,
            payload: { itemType: "assistant_message" as const, status: "completed" as const },
          });
          context.activeAssistantItemId = undefined;
          break;

        case "tool_execution_start":
        case "tool_call": {
          const tname = toolNameFromEvent(event);
          const key = toolKeyFromEvent(event);
          const itemId = RuntimeItemId.make(`pi-tool-${(yield* randomUUIDv4).slice(0, 8)}`);
          context.activeToolItemIds.set(key, itemId);
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, itemId: String(itemId), raw: event })),
            type: "item.started" as const,
            payload: { itemType: toolItemType(tname), status: "inProgress" as const, title: tname, data: event },
          });
          break;
        }

        case "tool_execution_update":
        case "tool_result": {
          const tdelta = textFromUnknown(event);
          if (tdelta.length > 0) {
            const itemId = context.activeToolItemIds.get(toolKeyFromEvent(event));
            yield* emit({
              ...(yield* buildEventBase({ threadId, turnId, itemId: itemId ? String(itemId) : undefined, raw: event })),
              type: "content.delta" as const,
              payload: { streamKind: "command_output" as const, delta: tdelta },
            });
          }
          break;
        }

        case "tool_execution_end": {
          const tname = toolNameFromEvent(event);
          const key = toolKeyFromEvent(event);
          const itemId = context.activeToolItemIds.get(key);
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, itemId: itemId ? String(itemId) : undefined, raw: event })),
            type: "item.completed" as const,
            payload: { itemType: toolItemType(tname), status: "completed" as const, title: tname, data: event },
          });
          context.activeToolItemIds.delete(key);
          break;
        }

        case "compaction_start":
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "item.started" as const,
            payload: { itemType: "context_compaction" as const, status: "inProgress" as const, title: "Compacting" },
          });
          break;

        case "compaction_end":
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "item.completed" as const,
            payload: { itemType: "context_compaction" as const, status: "completed" as const, title: "Compacted" },
          });
          break;

        case "agent_end":
        case "turn_end":
          yield* completeActiveTurn(context, event);
          break;

        case "process_exit": {
          const code = (event as Record<string, unknown>).code;
          const signal = (event as Record<string, unknown>).signal;
          const detail = `Pi process exited${typeof code === "number" ? ` with code ${code}` : ""}${typeof signal === "string" ? ` (${signal})` : ""}.`;
          if (context.activeTurnId) {
            yield* failActiveTurn(context, detail, event);
          } else {
            yield* updateSession(context, { status: "closed" as const, lastError: detail }, { clearActiveTurnId: true });
            yield* emit({
              ...(yield* buildEventBase({ threadId, raw: event })),
              type: "session.exited" as const,
              payload: { reason: detail, recoverable: true, exitKind: "error" as const }
            });
          }
          yield* Ref.set(context.stopped, true);
          sessions.delete(threadId);
          break;
        }

        default:
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "runtime.warning" as const,
            payload: { message: `Unhandled Pi event: ${evType}`, detail: event },
          });
      }
    });

    // ── adapter surface ────────────────────────────────────────────────────

    const startSession = Effect.fn("startSession")(function* (input: ProviderSessionStartInput) {
      const existing = sessions.get(input.threadId);
      if (existing) return existing.session as unknown as ProviderSession;

      const sessionScope = yield* Scope.make();
      const client = new PiJsonlRpcClient({
        binaryPath: piSettings.binaryPath,
        cwd: input.cwd,
        env: piEnvFromSettings(piSettings, options?.environment ?? process.env),
        args: piArgsFromSettings(piSettings),
      });

      const createdAt = yield* nowIso;
      const session: ProviderSession & Record<string, unknown> = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "connecting" as const,
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(piSettings.model ? { model: piSettings.model } : {}),
        threadId: input.threadId,
        createdAt,
        updatedAt: createdAt,
      };

      const context: PiSessionContext = {
        session,
        client,
        turns: [],
        pendingRequests: new Map(),
        activeToolItemIds: new Map(),
        stopped: yield* Ref.make(false),
        sessionScope,
        activeTurnId: undefined,
        activeAssistantItemId: undefined,
      };
      sessions.set(input.threadId, context);

      // Wire event pump — forked into session scope for automatic teardown
      client.onEvent((event) => {
        handlePiEvent(context, event).pipe(Effect.ignoreCause, Effect.runFork);
      });

      // Start the Pi process
      yield* Effect.tryPromise({
        try: () => client.start(),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      // Get Pi state
      yield* Effect.tryPromise({
        try: () => client.request({ type: "get_state" } as any),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "get_state",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      yield* updateSession(context, { status: "ready" as const });

      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "session.started",
        payload: { message: "Pi RPC session started." },
      });
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "thread.started",
        payload: {},
      });
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "session.state.changed",
        payload: { state: "ready" },
      });

      return context.session as unknown as ProviderSession;
    });

    const sendTurn = Effect.fn("sendTurn")(function* (input: ProviderSendTurnInput) {
      const context = ensureContext(sessions, input.threadId);
      const turnId = TurnId.make(`pi-turn-${yield* randomUUIDv4}`);

      context.activeTurnId = turnId;
      yield* updateSession(context, { status: "running" as const, activeTurnId: turnId });

      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: {},
      });

      const response = yield* Effect.tryPromise({
        try: () => context.client.request({ type: "prompt", message: input.input ?? "" } as any),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }).pipe(
        Effect.catch((error: ProviderAdapterRequestError) =>
          Effect.gen(function* () {
            yield* failActiveTurn(context, error.detail, error);
            return yield* error;
          }),
        ),
      );

      if (!response.success) {
        yield* failActiveTurn(context, response.error || "Pi prompt failed.", response);
      }

      return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
    });

    const interruptTurn = Effect.fn("interruptTurn")(function* (
      threadId: ThreadId,
      turnId?: TurnId,
    ) {
      const context = ensureContext(sessions, threadId);

      yield* Effect.tryPromise({
        try: () => context.client.request({ type: "abort" } as any),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "abort",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      const resolved = turnId ?? context.activeTurnId;
      context.activeTurnId = undefined;
      yield* updateSession(context, { status: "ready" as const }, { clearActiveTurnId: true });

      if (resolved) {
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: resolved })),
          type: "turn.aborted",
          payload: { reason: "User interrupted Pi turn." },
        });
      }
    });

    const respondToRequest = Effect.fn("respondToRequest")(function* (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) {
      const context = ensureContext(sessions, threadId);
      const rid = RuntimeRequestId.make(requestId as unknown as string);

      let piReq: { piRequestId: string; requestId: RuntimeRequestId } | undefined;
      for (const [, value] of context.pendingRequests) {
        if (String(value.requestId) === String(rid)) {
          piReq = value;
          break;
        }
      }

      if (!piReq) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown Pi request: ${requestId}`,
        });
      }

      context.client.sendExtensionUiResponse({
        id: piReq.piRequestId,
        confirmed: decision === "accept" || decision === "acceptForSession",
      });
      context.pendingRequests.delete(piReq.piRequestId);

      yield* emit({
        ...(yield* buildEventBase({
          threadId,
          requestId: String(rid),
          raw: { decision, piRequestId: piReq.piRequestId },
        })),
        type: "request.resolved" as const,
        payload: { requestType: "dynamic_tool_call" as const, decision: decision as string },
      });
    });

    const respondToUserInput = Effect.fn("respondToUserInput")(function* (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) {
      const context = ensureContext(sessions, threadId);
      const rid = RuntimeRequestId.make(requestId as unknown as string);

      let piReq: { piRequestId: string; requestId: RuntimeRequestId } | undefined;
      for (const [, value] of context.pendingRequests) {
        if (String(value.requestId) === String(rid)) {
          piReq = value;
          break;
        }
      }

      if (!piReq) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown Pi user-input request: ${requestId}`,
        });
      }

      const firstVal = Object.values(answers)[0];
      context.client.sendExtensionUiResponse({
        id: piReq.piRequestId,
        value: String(firstVal ?? ""),
      });
      context.pendingRequests.delete(piReq.piRequestId);

      yield* emit({
        ...(yield* buildEventBase({ threadId, requestId: String(rid) })),
        type: "user-input.resolved" as const,
        payload: { answers },
      });
    });

    const stopSession = Effect.fn("stopSession")(function* (threadId: ThreadId) {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      const stopped = yield* stopPiContext(context);
      sessions.delete(threadId);
      if (stopped) {
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited" as const,
          payload: { reason: "Session stopped.", recoverable: false, exitKind: "graceful" as const },
        });
      }
    });

    const listSessions = () =>
      Effect.sync(() => [...sessions.values()].map((c) => c.session as unknown as ProviderSession));

    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() => sessions.has(threadId));

    // eslint-disable-next-line require-yield
    const readThread = Effect.fn("readThread")(function* (threadId: ThreadId) {
      const context = ensureContext(sessions, threadId);
      return { threadId, turns: context.turns };
    });

    const rollbackThread = () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Pi rollback is not supported.",
        }),
      );

    const stopAll = Effect.fn("stopAll")(function* () {
      const contexts = [...sessions.values()];
      sessions.clear();
      yield* Effect.forEach(
        contexts,
        (context) => stopPiContext(context).pipe(Effect.ignoreCause),
        { concurrency: "unbounded", discard: true },
      );
    });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" as const },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies ProviderAdapterShape<ProviderAdapterRequestError | ProviderAdapterProcessError | ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError>;
  });
}
