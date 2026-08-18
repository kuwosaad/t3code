import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PiAgentIcon } from "../Icons";
import { AVAILABLE_PROVIDER_OPTIONS, PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("Pi provider metadata", () => {
  it("exposes Pi as an available provider with its native icon", () => {
    const pi = ProviderDriverKind.make("pi");

    expect(AVAILABLE_PROVIDER_OPTIONS).toContainEqual({
      value: pi,
      label: "Pi",
      available: true,
    });
    expect(PROVIDER_ICON_BY_PROVIDER[pi]).toBe(PiAgentIcon);
  });
});
