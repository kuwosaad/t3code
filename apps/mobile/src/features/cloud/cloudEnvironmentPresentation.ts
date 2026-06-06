import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";

export type AvailableCloudEnvironmentState = "available" | "connecting" | "disconnected";

export interface AvailableCloudEnvironmentPresentation {
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
  readonly connectionState: AvailableCloudEnvironmentState;
  readonly statusText: string;
}

export function availableCloudEnvironmentPresentation(input: {
  readonly isConnecting: boolean;
  readonly isStatusPending: boolean;
  readonly status: RelayEnvironmentStatusResponse | null;
  readonly statusError: string | null;
  readonly statusErrorTraceId: string | null;
}): AvailableCloudEnvironmentPresentation {
  if (input.isConnecting) {
    return {
      connectionError: null,
      connectionErrorTraceId: null,
      connectionState: "connecting",
      statusText: "Connecting...",
    };
  }

  if (input.status?.status === "online") {
    return {
      connectionError: null,
      connectionErrorTraceId: null,
      connectionState: "available",
      statusText: "Available · Relay online",
    };
  }

  if (input.status?.status === "offline") {
    const connectionError = input.status.error ?? "Relay is offline.";
    return {
      connectionError,
      connectionErrorTraceId: null,
      connectionState: "disconnected",
      statusText: connectionError,
    };
  }

  if (input.statusError) {
    return {
      connectionError: input.statusError,
      connectionErrorTraceId: input.statusErrorTraceId,
      connectionState: "disconnected",
      statusText: input.statusError,
    };
  }

  return {
    connectionError: null,
    connectionErrorTraceId: null,
    connectionState: "available",
    statusText: input.isStatusPending
      ? "Available · Checking relay status..."
      : "Available · Relay status unknown",
  };
}
