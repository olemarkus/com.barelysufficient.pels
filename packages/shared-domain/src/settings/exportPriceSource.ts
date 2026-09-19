/**
 * The `export_price_source` setting: one key, one reader.
 *
 * Where the feed-in price comes from — what the owner is paid for power they
 * send to the grid:
 *
 * - `manual` — the amounts the owner typed into PELS (a share of the spot
 *   price, plus a fixed amount). The only source that existed before this key,
 *   and still the only one on price sources where Homey holds no export terms.
 * - `homey_energy` — Homey's own export pricing, which it models exactly as it
 *   models import pricing: a type (`fixed | dynamic | disabled`), a fixed
 *   per-kWh amount, and for dynamic a formula over each period's spot price.
 *
 * The key exists because both are legitimate and only the owner knows which
 * they mean. Reading Homey's terms when they are set and silently ignoring the
 * owner's own fields would be a judgement PELS is not entitled to make, and it
 * would change what an existing home is paid for its solar without asking.
 *
 * Both sides read these bytes — the runtime to price, the settings UI to render
 * and edit the selector — so the type and the read policy live here, once
 * (`notes/settings-key-ownership.md`).
 *
 * ## Read policy: RECOGNISE OR DEFAULT
 *
 * A flat two-value union with nothing to sanitize partially. Anything else,
 * absence included, reads as `manual`: the behaviour every home had before this
 * key existed, so an upgrade keeps paying out exactly what it paid yesterday
 * and a never-written key means what it has always meant. Choosing Homey's
 * terms is therefore always an explicit act by the owner.
 *
 * Absence stays with the callers, as ever: the runtime can cross-check
 * `getKeys()`, the settings UI cannot. Here the two coincide, because a
 * transient miss and a never-written key both want `manual` — the source that
 * does not depend on a read PELS might not have managed.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

export type ExportPriceSourceSetting = 'manual' | 'homey_energy';

export const EXPORT_PRICE_SOURCE_DEFAULT: ExportPriceSourceSetting = 'manual';

export const isExportPriceSourceSetting = (
  value: unknown,
): value is ExportPriceSourceSetting => (
  value === 'manual' || value === 'homey_energy'
);

export const readExportPriceSourceSetting = (value: unknown): ExportPriceSourceSetting => (
  isExportPriceSourceSetting(value) ? value : EXPORT_PRICE_SOURCE_DEFAULT
);
