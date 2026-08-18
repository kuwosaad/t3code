import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ModelSlugItem {
  readonly slug: string;
}

export interface ProviderModelItem extends ModelSlugItem {
  readonly instanceId: ProviderInstanceId;
}

export interface SubProviderModelGroup<T> {
  readonly subProvider: string | undefined;
  readonly models: ReadonlyArray<T>;
}

export function providerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}:${slug}`;
}

function rankByValue(values: ReadonlyArray<string>): ReadonlyMap<string, number> {
  return new Map(Arr.map(values, (value, index) => [value, index] as const));
}

function toSet(
  values: ReadonlySet<string> | ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function byOptionalRank<T>(rank: (item: T) => number | undefined): Order.Order<T> {
  return Order.mapInput(Order.Number, (item: T) => rank(item) ?? Number.POSITIVE_INFINITY);
}

function byTrueFirst<T>(predicate: (item: T) => boolean): Order.Order<T> {
  return Order.mapInput(Order.flip(Order.Boolean), predicate);
}

export function groupModelsBySubProvider<T extends { readonly subProvider?: string }>(
  models: ReadonlyArray<T>,
  options?: { readonly isFavorite?: (model: T) => boolean },
): ReadonlyArray<SubProviderModelGroup<T>> {
  const isFavorite = options?.isFavorite;
  const groups = new Map<string, { subProvider: string | undefined; models: T[] }>();
  for (const model of models) {
    const subProvider = model.subProvider?.trim() || undefined;
    const key = subProvider?.toLocaleLowerCase() ?? "";
    const group = groups.get(key);
    if (group) {
      group.models.push(model);
    } else {
      groups.set(key, { subProvider, models: [model] });
    }
  }

  return [...groups.values()].map((group) => ({
    subProvider: group.subProvider,
    models:
      isFavorite === undefined
        ? group.models
        : group.models.toSorted((a, b) => Number(isFavorite(b)) - Number(isFavorite(a))),
  }));
}

export function sortModelsForProviderInstance<T extends ModelSlugItem>(
  models: ReadonlyArray<T>,
  options?: {
    readonly modelOrder?: ReadonlyArray<string>;
    readonly favoriteModels?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
  },
): T[] {
  const modelOrder = options?.modelOrder ?? [];
  const favoriteModels = toSet(options?.favoriteModels);
  const orderBySlug = rankByValue(modelOrder);
  const originalOrder = rankByValue(Arr.map(models, (model) => model.slug));
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [byTrueFirst<T>((model) => favoriteModels.has(model.slug))]
      : []),
    byOptionalRank((model) => orderBySlug.get(model.slug)),
    byOptionalRank((model) => originalOrder.get(model.slug)),
  ];

  return Arr.sort(models, Order.combineAll(orders));
}

export function sortProviderModelItems<T extends ProviderModelItem>(
  items: ReadonlyArray<T>,
  options?: {
    readonly favoriteModelKeys?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
    readonly instanceOrder?: ReadonlyArray<ProviderInstanceId>;
  },
): T[] {
  const favoriteModelKeys = toSet(options?.favoriteModelKeys);
  const instanceOrder = new Map(
    Arr.map(options?.instanceOrder ?? [], (instanceId, index) => [instanceId, index] as const),
  );
  const originalOrder = rankByValue(
    Arr.map(items, (item) => providerModelKey(item.instanceId, item.slug)),
  );
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [
          byTrueFirst<T>((item) =>
            favoriteModelKeys.has(providerModelKey(item.instanceId, item.slug)),
          ),
        ]
      : []),
    byOptionalRank((item) => instanceOrder.get(item.instanceId)),
    byOptionalRank((item) => originalOrder.get(providerModelKey(item.instanceId, item.slug))),
  ];

  return Arr.sort(items, Order.combineAll(orders));
}
