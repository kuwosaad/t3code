import { describe, expect, it } from "vite-plus/test";

import { makePiModelSlug, parsePiModelSlug } from "./PiModelSlug.ts";

describe("Pi model slugs", () => {
  it("round-trips provider-qualified models", () => {
    const slug = makePiModelSlug("grok", "gpt-5.6-luna");

    expect(slug).toBe("pi/grok/gpt-5.6-luna");
    expect(parsePiModelSlug(slug)).toEqual({ provider: "grok", model: "gpt-5.6-luna" });
  });

  it("round-trips providerless models while preserving the providerless marker", () => {
    const slug = makePiModelSlug(undefined, "custom-model");

    expect(slug).toBe("pi/custom-model");
    expect(parsePiModelSlug(slug)).toEqual({ provider: undefined, model: "custom-model" });
  });

  it("rejects malformed or non-Pi slugs", () => {
    for (const slug of [undefined, "", "custom-model", "pi/", "pi//model", "pi/provider/"]) {
      expect(parsePiModelSlug(slug)).toBeUndefined();
    }
  });
});
