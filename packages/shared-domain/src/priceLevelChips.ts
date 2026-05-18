// Surface a single info chip for the cheap / expensive price-level signal.
//
// `priceLevel` is a free-form string from the Homey price API; only the two
// canonical values map to actionable user copy. Anything else (including
// `normal`, `null`, or unrecognised tags) returns `null` so the surface stays
// calm when there is nothing to say.
//
// Lives in shared-domain so both the settings UI and runtime logging speak
// the same words for the same signal (per `feedback_ui_text_shared_with_logs`).

export type PriceLevelChipTone = 'info' | 'warn';

// Mirrors the runtime `PriceLevel` enum string values in
// `lib/price/priceLevels.ts`. Kept as a literal union (not an import) because
// `shared-domain` must stay free of `lib/**` runtime imports. The `satisfies`
// clause on `PRICE_LEVEL_CHIP_DEFS` pins the keys to this union so a future
// runtime rename forces an update here instead of silently failing the lookup.
export type PriceLevelTag = 'cheap' | 'normal' | 'expensive' | 'unknown';

export type PriceLevelChip = {
  label: string;
  tone: PriceLevelChipTone;
  /** Raw price level for `data-` attributes / log tags. */
  priceLevel: string;
};

const PRICE_LEVEL_CHIP_DEFS = {
  cheap: { label: 'Price low', tone: 'info' },
  expensive: { label: 'Price high', tone: 'warn' },
} as const satisfies Partial<Record<PriceLevelTag, { label: string; tone: PriceLevelChipTone }>>;

const isMappedTag = (
  value: string,
): value is keyof typeof PRICE_LEVEL_CHIP_DEFS => (
  // `in` walks the prototype chain, so plain strings like `toString` /
  // `constructor` would match and produce a chip with undefined label/tone.
  // Use an own-property check so unrecognized free-form values fall through.
  Object.prototype.hasOwnProperty.call(PRICE_LEVEL_CHIP_DEFS, value)
);

export const resolvePriceLevelChip = (
  priceLevel: string | null | undefined,
): PriceLevelChip | null => {
  if (!priceLevel || !isMappedTag(priceLevel)) return null;
  const def = PRICE_LEVEL_CHIP_DEFS[priceLevel];
  return { label: def.label, tone: def.tone, priceLevel };
};
