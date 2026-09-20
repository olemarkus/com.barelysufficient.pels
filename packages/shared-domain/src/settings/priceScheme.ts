/**
 * The `price_scheme` and `powerhour_device_id` settings: one key, one reader.
 *
 * Together they answer one question — where this home's prices come from — and
 * both sides ask it. The runtime reads them over `homey.settings` to build the
 * price series; the settings UI reads the same bytes over the Homey API bridge
 * to render the source selector and, on the Power by the Hour source, which of
 * that app's price devices is in force.
 *
 * They lived in two hand-written copies before this module: `PriceScheme` in
 * `lib/price/priceTypes.ts` and again in the settings UI's
 * `priceSettingsPersistence.ts`. That is exactly the drift
 * `notes/settings-key-ownership.md` exists to prevent — two parsers for one
 * key, each free to disagree about a value neither wrote — and it became
 * load-bearing the moment a fourth source had to be added to both.
 *
 * Transport stays with the callers, and so does the meaning of ABSENCE: the
 * runtime can cross-check `getKeys()`, the settings UI cannot. For
 * `powerhour_device_id` the two genuinely differ and both readings are right:
 * the settings UI renders "no device chosen" and the runtime tells that apart
 * from a read that did not come back, because a missed read there would report
 * a choice the owner DID make as un-made and stop the price refresh
 * (`readPowerhourDeviceChoice` in `lib/price/powerhourScheme.ts`). That is the
 * division this note's transport section describes, not a gap in this policy.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

import type { PriceSchemeSetting } from '../../../contracts/src/settingsUiApi.js';

/**
 * Read policy: RECOGNISE OR DEFAULT.
 *
 * A flat union with nothing to sanitize partially — a value is one of the four
 * or it is not. Anything else, absence included, reads as `norway`: the source
 * every home had before the key existed, so a never-written key still means
 * what it has always meant and an upgrade prices the home exactly as it did
 * yesterday. Every other source is therefore an explicit choice by the owner.
 *
 * The settings UI keeps one reading of its own — the value of the `<select>`
 * element, which is not these bytes and defaults to whatever the form shows —
 * and it is deliberately not this function.
 */
export const isPriceSchemeSetting = (value: unknown): value is PriceSchemeSetting => (
  value === 'norway' || value === 'flow' || value === 'homey' || value === 'powerhour'
);

export const readPriceSchemeSetting = (value: unknown): PriceSchemeSetting => (
  isPriceSchemeSetting(value) ? value : 'norway'
);

/**
 * Read policy for `powerhour_device_id`: A NON-EMPTY STRING, OR NONE.
 *
 * The id is minted by Power by the Hour (`<biddingZone>_<random>`), so PELS has
 * no grammar to check it against and no business inventing one — anything that
 * is not a usable string is simply no choice at all.
 *
 * `null` means the owner has not picked a device, which is a real state with
 * its own behaviour and not a failure: on a home with exactly one price device
 * there is nothing to choose, so the source resolves it (`resolvePowerhourDevice`
 * in `lib/price/powerhourScheme.ts`). It stops being resolvable the moment a
 * second device appears, and the settings UI asks then.
 *
 * What `null` does NOT mean is "this read failed". Distinguishing those needs a
 * second read, and this function is shared with the settings UI, which must
 * never make an SDK call it does not have. The runtime resolves that ambiguity
 * at its own read site, as it does for `pv_forecast_source`.
 */
export const readPowerhourDeviceIdSetting = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export type { PriceSchemeSetting };
