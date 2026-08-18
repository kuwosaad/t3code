const PI_MODEL_SLUG_PREFIX = "pi/";

export function makePiModelSlug(provider: string | undefined, modelId: string): string {
  const normalizedModelId = modelId.trim();
  const normalizedProvider = provider?.trim();
  return normalizedProvider
    ? `${PI_MODEL_SLUG_PREFIX}${normalizedProvider}/${normalizedModelId}`
    : `${PI_MODEL_SLUG_PREFIX}${normalizedModelId}`;
}

export function parsePiModelSlug(
  slug: string | undefined,
): { readonly provider: string | undefined; readonly model: string } | undefined {
  if (!slug?.startsWith(PI_MODEL_SLUG_PREFIX)) return undefined;
  const encoded = slug.slice(PI_MODEL_SLUG_PREFIX.length);
  const separatorIndex = encoded.indexOf("/");
  if (separatorIndex === -1) {
    return encoded.trim().length > 0 ? { provider: undefined, model: encoded.trim() } : undefined;
  }
  if (separatorIndex <= 0 || separatorIndex === encoded.length - 1) return undefined;
  const provider = encoded.slice(0, separatorIndex).trim();
  const model = encoded.slice(separatorIndex + 1).trim();
  return provider && model ? { provider, model } : undefined;
}
