// Surface a single info chip for the cheap / expensive price-level signal.
//
// `priceLevel` is a free-form string from the Homey price API; only the two
// canonical values map to actionable user copy. Anything else (including
// `normal`, `null`, or unrecognised tags) returns `null` so the chip rail
// stays calm when there is nothing to say.
//
// Lives in shared-domain so both the settings UI and runtime logging speak
// the same words for the same signal (per `feedback_ui_text_shared_with_logs`).

export type PriceLevelChipTone = 'info' | 'warn';

export type PriceLevelChip = {
  label: string;
  tone: PriceLevelChipTone;
  /** Raw price level for `data-` attributes / log tags. */
  priceLevel: string;
};

const PRICE_LEVEL_CHIP_DEFS: Record<string, { label: string; tone: PriceLevelChipTone }> = {
  cheap: { label: 'Price low', tone: 'info' },
  expensive: { label: 'Price high', tone: 'warn' },
};

export const resolvePriceLevelChip = (
  priceLevel: string | null | undefined,
): PriceLevelChip | null => {
  if (!priceLevel) return null;
  const def = PRICE_LEVEL_CHIP_DEFS[priceLevel];
  if (!def) return null;
  return { label: def.label, tone: def.tone, priceLevel };
};
