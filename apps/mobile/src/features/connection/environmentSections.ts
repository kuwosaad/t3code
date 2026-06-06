import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";

export interface EnvironmentSectionsInput {
  readonly connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly cloudEnvironments: ReadonlyArray<RelayClientEnvironmentRecord> | null;
}

export interface EnvironmentSections {
  readonly localEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly connectedCloudEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly availableCloudEnvironments: ReadonlyArray<RelayClientEnvironmentRecord>;
}

function isActiveOrFailedCloudConnection(environment: ConnectedEnvironmentSummary): boolean {
  return (
    environment.connectionError !== null ||
    (environment.connectionState !== "idle" && environment.connectionState !== "disconnected")
  );
}

export function splitEnvironmentSections(input: EnvironmentSectionsInput): EnvironmentSections {
  const advertisedCloudEnvironmentIds = new Set(
    (input.cloudEnvironments ?? []).map((environment) => environment.environmentId),
  );
  const savedEnvironmentIds = new Set(
    input.connectedEnvironments
      .filter(
        (environment) =>
          !environment.isRelayManaged ||
          isActiveOrFailedCloudConnection(environment) ||
          !advertisedCloudEnvironmentIds.has(environment.environmentId),
      )
      .map((environment) => environment.environmentId),
  );

  return {
    localEnvironments: input.connectedEnvironments.filter(
      (environment) => !environment.isRelayManaged,
    ),
    connectedCloudEnvironments: input.connectedEnvironments.filter(
      (environment) =>
        environment.isRelayManaged &&
        (isActiveOrFailedCloudConnection(environment) ||
          !advertisedCloudEnvironmentIds.has(environment.environmentId)),
    ),
    availableCloudEnvironments: (input.cloudEnvironments ?? []).filter(
      (environment) => !savedEnvironmentIds.has(environment.environmentId),
    ),
  };
}
