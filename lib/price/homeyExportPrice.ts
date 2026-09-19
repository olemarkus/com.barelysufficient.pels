/**
 * Homey's own feed-in pricing, read and applied.
 *
 * Homey models what the owner is paid for exported power the same way it models
 * what they pay to import: a type, and terms that depend on it.
 *
 * - `manager/energy/price/electricity/exported/type` → `fixed | dynamic | disabled`
 * - `manager/energy/option/electricityPriceExportedFixed` → a per-kWh amount,
 *   carried as a map of named cost components that sum to the price (Homey's
 *   own `getCurrentElectricityPriceExportedFixed` sums them the same way). It
 *   may be negative: in a market with feed-in charges, exporting costs money.
 * - `manager/energy/price/electricity/dynamic/exported-user-costs` → a formula
 *   over each period, exactly like the import one, except that it may also
 *   reference `[[importPrice]]` — the all-in import price for that period — so
 *   an owner can express "what I pay, minus 10 øre" in one expression.
 *
 * None of it is exposed as a ready-made per-period series: like the import
 * formula, Homey applies the terms only inside its own features and expects a
 * consumer to apply them on read (`lib/price/priceFormula.ts` has the evidence).
 *
 * This is read ONLY when the owner has pointed the export price at Homey
 * (`export_price_source`), because PELS's own export fields are the other
 * legitimate answer and the choice is theirs
 * (`packages/shared-domain/src/settings/exportPriceSource.ts`).
 */

import { resolveHomeyHttpStatusCode } from '../utils/homeyHttpStatusError';
import {
  HOMEY_EXPORT_PRICE_TERMS,
} from '../utils/settingsKeys';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { PriceServiceLoggingSinks } from './priceServiceLoggingSinks';
import { compilePriceFormula } from './priceFormula';
import type { HomeyWebApiGet } from './homeyWebApiPort';

export const EXPORT_TYPE_API_PATH = 'manager/energy/price/electricity/exported/type';
export const EXPORT_FIXED_OPTION_API_PATH = 'manager/energy/option/electricityPriceExportedFixed';
export const EXPORT_USER_COSTS_API_PATH = 'manager/energy/price/electricity/dynamic/exported-user-costs';

/**
 * What Homey says the owner is paid, reduced to the two shapes that actually
 * price a period, plus the two that price nothing.
 *
 * `disabled` is a real answer — the owner has told Homey they are paid nothing
 * for export — and it is NOT the same as `failed`, which is a read that never
 * arrived. The first is mirrored and honoured; the second changes nothing.
 */
export type HomeyExportTerms =
  | { kind: 'fixed'; amount: number }
  | { kind: 'formula'; expression: string }
  | { kind: 'disabled' }
  | { kind: 'failed'; reasonCode: 'read_threw' | 'unrecognised_body' };

const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
);

/**
 * Sum Homey's named cost components, the way Homey sums them itself.
 *
 * The shape is `{ costs: { <name>: { value: number } } }`. A component whose
 * value is not a finite number makes the whole amount untrustworthy rather than
 * merely smaller, so the sum refuses instead of skipping it — a feed-in price
 * that silently omits one of its parts is worse than none.
 */
export const sumExportCostComponents = (value: unknown): number | null => {
  const option = asRecord(value);
  const costs = asRecord(option?.costs);
  if (!costs) return null;
  const components = Object.values(costs);
  if (components.length === 0) return null;
  let total = 0;
  for (const component of components) {
    const amount = asRecord(component)?.value;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
    total += amount;
  }
  return total;
};

/**
 * Read Homey's export terms, classifying the whole space at this boundary.
 *
 * Three routes, read in the order the type dictates, so a home with export
 * disabled costs one read rather than three.
 */
export const fetchHomeyExportTerms = async (
  webApiGet: HomeyWebApiGet,
): Promise<HomeyExportTerms> => {
  try {
    const type = await webApiGet(EXPORT_TYPE_API_PATH);
    if (type === 'disabled' || type === null) return { kind: 'disabled' };
    if (type === 'fixed') {
      const amount = sumExportCostComponents(asRecord(await webApiGet(EXPORT_FIXED_OPTION_API_PATH))?.value);
      // A `fixed` type whose amount has never been entered prices nothing, and
      // is the owner's configuration half-done rather than a read failure.
      return amount === null
        ? { kind: 'failed', reasonCode: 'unrecognised_body' }
        : { kind: 'fixed', amount };
    }
    if (type === 'dynamic') {
      const body = await webApiGet(EXPORT_USER_COSTS_API_PATH);
      const expression = asRecord(body)?.mathExpression;
      // Homey applies no raw-spot fallback on the export side: a dynamic export
      // with no expression is unpriced there too, so it prices nothing here.
      if (body === null) return { kind: 'disabled' };
      if (typeof expression !== 'string' || !expression.trim()) {
        return { kind: 'failed', reasonCode: 'unrecognised_body' };
      }
      return { kind: 'formula', expression };
    }
    return { kind: 'failed', reasonCode: 'unrecognised_body' };
  } catch (error) {
    // A 404 is firmware with no export pricing at all — the same outcome as an
    // owner who disabled it, and equally settled.
    return resolveHomeyHttpStatusCode(error) === 404
      ? { kind: 'disabled' }
      : { kind: 'failed', reasonCode: 'read_threw' };
  }
};

/**
 * The mirrored terms, in the shape they are stored.
 *
 * Mirrored for the same reason the import formula is: the price series is built
 * synchronously and often, and a restart must not spend its first minutes
 * paying the owner a number PELS made up. `null` terms are a recorded "Homey
 * pays nothing for export here", which is a fact about the home; an absent key
 * means we have never had an answer.
 */
type MirroredExportTerms =
  | { fixedAmount: number }
  | { mathExpression: string }
  | { disabled: true };

/**
 * What the mirror says, including the case where it will not say.
 *
 * `suspect` is a key the SDK LISTS but does not hand back usable bytes — the
 * transient read miss this platform produces. Collapsing it into "no terms"
 * would drop the feed-in price out of an otherwise valid series and persist
 * that loss, which is a decision taken on a failed read
 * (`notes/persisted-settings-state.md`).
 */
export type ExportTermsRead =
  | { kind: 'terms'; value: MirroredExportTerms }
  | { kind: 'absent' }
  | { kind: 'suspect' };

export const readExportTerms = (settings: SettingsPort): ExportTermsRead => {
  const raw = settings.get(HOMEY_EXPORT_PRICE_TERMS);
  if (raw === undefined || raw === null) {
    return settings.getKeys().includes(HOMEY_EXPORT_PRICE_TERMS)
      ? { kind: 'suspect' }
      : { kind: 'absent' };
  }
  const stored = asRecord(raw);
  if (!stored) return { kind: 'suspect' };
  if (stored.disabled === true) return { kind: 'terms', value: { disabled: true } };
  if (typeof stored.fixedAmount === 'number' && Number.isFinite(stored.fixedAmount)) {
    return { kind: 'terms', value: { fixedAmount: stored.fixedAmount } };
  }
  if (typeof stored.mathExpression === 'string' && stored.mathExpression.trim()) {
    return { kind: 'terms', value: { mathExpression: stored.mathExpression } };
  }
  return { kind: 'suspect' };
};

const readMirroredTerms = (settings: SettingsPort): MirroredExportTerms | null => {
  const read = readExportTerms(settings);
  return read.kind === 'terms' ? read.value : null;
};

/**
 * Whether Homey's terms have ever been mirrored here.
 *
 * A second witness to the owner's choice: terms are synced ONLY while the
 * export source is Homey, so their presence says the source was Homey when
 * they were written. Used when the source key itself reads back unusable.
 */
export const hasMirroredExportTerms = (settings: SettingsPort): boolean => (
  readExportTerms(settings).kind === 'terms'
);

const toMirroredTerms = (terms: HomeyExportTerms): MirroredExportTerms | null => {
  if (terms.kind === 'fixed') return { fixedAmount: terms.amount };
  if (terms.kind === 'formula') return { mathExpression: terms.expression };
  if (terms.kind === 'disabled') return { disabled: true };
  return null;
};

/**
 * Apply a fresh read to the mirror, skipping a write that would change nothing:
 * every settings write ships the entire settings object to Homey core.
 */
export const persistHomeyExportTerms = (
  settings: SettingsPort,
  terms: HomeyExportTerms,
): boolean => {
  const next = toMirroredTerms(terms);
  if (!next) return false;
  const stored = readMirroredTerms(settings);
  if (stored && JSON.stringify(stored) === JSON.stringify(next)) return false;
  settings.set(HOMEY_EXPORT_PRICE_TERMS, next);
  return true;
};

/**
 * Read Homey's export terms and mirror them, reporting whether they moved.
 *
 * The edge, and so where the classification is logged: a failed read leaves the
 * last known terms in place and says so once per refresh, not once per build.
 */
export const syncHomeyExportTerms = async (
  webApiGet: HomeyWebApiGet,
  settings: SettingsPort,
  sinks: PriceServiceLoggingSinks,
): Promise<boolean> => {
  const terms = await fetchHomeyExportTerms(webApiGet);
  if (terms.kind === 'failed') {
    sinks.structuredLog?.warn({
      event: 'homey_export_terms_read_failed',
      reasonCode: terms.reasonCode,
    });
    return false;
  }
  const changed = persistHomeyExportTerms(settings, terms);
  if (!changed) {
    sinks.debugStructured({ event: 'homey_export_terms_unchanged', kind: terms.kind });
    return false;
  }
  sinks.structuredLog?.info({
    event: 'homey_export_terms_changed',
    kind: terms.kind,
    amount: terms.kind === 'fixed' ? terms.amount : null,
    expression: terms.kind === 'formula' ? terms.expression : null,
  });
  return true;
};

/**
 * The feed-in price for one period under Homey's terms, or `null` when Homey
 * prices no export for this home.
 *
 * `spot` is the period's raw wholesale value and `importPrice` the all-in
 * import price PELS resolved for that same period — the two symbols a Homey
 * export formula may reference. The result is signed and deliberately never
 * clamped: a negative feed-in price is what a market with export charges looks
 * like, and hiding it would tell the owner exporting is free.
 */
export const resolveHomeyExportPrice = (
  settings: SettingsPort,
  spot: number,
  importPrice: number,
): number | null => {
  const terms = readMirroredTerms(settings);
  if (!terms || 'disabled' in terms) return null;
  if ('fixedAmount' in terms) return terms.fixedAmount;
  const formula = compilePriceFormula(terms.mathExpression);
  return formula ? formula.evaluate({ spot, importPrice }) : null;
};
