/**
 * Ownership of the Homey Energy price formula: the one semantic read the
 * adapter may produce, the one settings key that mirrors it, and the policy for
 * both sides of that key (`notes/settings-key-ownership.md`).
 *
 * The formula is Homey's, not ours — the owner edits it in the Homey app, and
 * PELS only mirrors it so an hourly price can be resolved from the raw spot
 * series (`lib/price/priceFormula.ts` explains why that resolution is ours to
 * do at all). It is mirrored rather than read live because the price series is
 * built synchronously, many times per hour, and a restart must not spend its
 * first minutes planning against bare wholesale spot.
 */

import type { SettingsPort } from '../ports/homeyRuntime';
import type { CombinedPricePeriod } from './priceTypes';
import { HOMEY_PRICE_FORMULA } from '../utils/settingsKeys';
import { resolveHomeyHttpStatusCode } from '../utils/homeyHttpStatusError';
import { compilePriceFormula, type CompiledPriceFormula } from './priceFormula';
import type { PriceServiceLoggingSinks } from './priceServiceLoggingSinks';

/**
 * What Homey's user-costs route said:
 *
 * - `configured` — mirror this expression.
 * - `none` — the owner has set no formula, so raw spot IS the price. Record
 *   that, rather than merely clearing the mirror: "Homey says there is no
 *   formula" and "we have never managed to ask" both leave no expression
 *   behind, and only the first of them makes raw spot the right price.
 * - `unavailable` — this firmware has no user-cost route at all (404), so
 *   there are no user costs to apply and raw spot is likewise the price. Kept
 *   apart from `none` so a log can say which, and so the branch can go when the
 *   supported firmware floor rises.
 * - `failed` — the read did not produce an answer. Says nothing about the
 *   owner's configuration, so the mirror is left exactly as it was
 *   (`AGENTS.md` → a transient external failure is a no-op, not an event).
 */
export type HomeyPriceFormulaRead =
  | { kind: 'configured'; expression: string }
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; reasonCode: 'read_threw' | 'unrecognised_body' };

/**
 * The one capability this read needs: a GET against Homey's own Web API,
 * relative to `/api`.
 *
 * Supplied by the wiring layer, which hands over the owner-token REST reader
 * every other manager read in PELS already uses (`setup/homeyWebApi.ts`).
 * Deliberately NOT the SDK's `homey.api.get`: an app's call through that bridge
 * is authenticated with an app-session header that only the app-to-app routes
 * accept, so a manager route rejects it.
 */
export type HomeyWebApiGet = (path: string) => Promise<unknown>;

export const PRICE_USER_COSTS_API_PATH = 'manager/energy/price/electricity/dynamic/user-costs';

/**
 * Read the owner's formula from Homey, and classify the answer completely
 * before the price build sees it.
 *
 * Exactly two answers establish that raw spot is the owner's price: a literal
 * `null` body, which is how Homey reports an unset option, and a 404, which is
 * firmware with no user-cost route at all. Everything else is `failed`, and
 * deliberately so — an empty body, a non-object, an object without a string
 * `mathExpression` (a partial or error-shaped response) tells us nothing about
 * the owner's configuration, and reading it as "no formula" would delete a good
 * mirror and revert every price to wholesale spot, which is lower than anything
 * the owner pays.
 */
export const fetchHomeyPriceFormula = async (
  webApiGet: HomeyWebApiGet,
): Promise<HomeyPriceFormulaRead> => {
  try {
    const body = await webApiGet(PRICE_USER_COSTS_API_PATH);
    if (body === null) return { kind: 'none' };
    if (typeof body !== 'object') return { kind: 'failed', reasonCode: 'unrecognised_body' };
    const expression = (body as { mathExpression?: unknown }).mathExpression;
    if (typeof expression !== 'string' || !expression.trim()) {
      // A shape we do not recognise — a partial response, or a body Homey has
      // since grown (the export side already answers a typed `fixed | dynamic |
      // disabled` on its own route). Treated as a failed read so the mirror
      // survives, and reported apart from a thrown one so a log can say which:
      // a body we never learn to read would otherwise retry in silence forever.
      return { kind: 'failed', reasonCode: 'unrecognised_body' };
    }
    return { kind: 'configured', expression };
  } catch (error) {
    return resolveHomeyHttpStatusCode(error) === 404
      ? { kind: 'unavailable' }
      : { kind: 'failed', reasonCode: 'read_threw' };
  }
};

/**
 * The mirrored value: what Homey last told us, whatever that was.
 *
 * `mathExpression: null` is a RECORDED "the owner has no formula", which is not
 * the same fact as the key being absent — that one means we have never had an
 * answer. The distinction is the whole point of storing an object rather than
 * the bare expression: only a recorded `null` makes raw spot the right price.
 */
type MirroredFormula = { mathExpression: string | null };

/**
 * What the mirror currently says, including the case where it will not say.
 *
 * `suspect` is a key the SDK LISTS but does not hand back usable bytes — a
 * transient read miss, which this platform does produce
 * (`notes/persisted-settings-state.md`). It is deliberately not `absent`: an
 * absent key means Homey has never answered us, and that verdict authorises
 * throwing away persisted prices, which a hiccup must never do.
 */
type MirrorRead =
  | { kind: 'stored'; value: MirroredFormula }
  | { kind: 'absent' }
  | { kind: 'suspect' };

const readMirror = (settings: SettingsPort): MirrorRead => {
  const stored = settings.get(HOMEY_PRICE_FORMULA);
  if (stored === undefined || stored === null) {
    // `getKeys()` is what tells "never written" from "listed but unreadable";
    // only the first is a fact about this home's configuration.
    return settings.getKeys().includes(HOMEY_PRICE_FORMULA) ? { kind: 'suspect' } : { kind: 'absent' };
  }
  if (typeof stored !== 'object') return { kind: 'suspect' };
  const { mathExpression } = stored as { mathExpression?: unknown };
  if (mathExpression === null) return { kind: 'stored', value: { mathExpression: null } };
  if (typeof mathExpression === 'string' && mathExpression.trim()) {
    return { kind: 'stored', value: { mathExpression } };
  }
  return { kind: 'suspect' };
};

/**
 * Apply a fresh read to the mirror. Returns whether the stored value changed,
 * so the caller can skip a no-op settings write: the SDK re-serialises and
 * ships the ENTIRE settings object to core on every `set`, which is the
 * allocation churn behind the memory-watchdog kills, and this key is re-read on
 * a 3-hour cadence while its value changes perhaps once a year.
 */
export const persistHomeyPriceFormula = (
  settings: SettingsPort,
  read: HomeyPriceFormulaRead,
): boolean => {
  if (read.kind === 'failed') return false;
  const next: MirroredFormula = read.kind === 'configured'
    ? { mathExpression: read.expression }
    : { mathExpression: null };
  const stored = readMirror(settings);
  if (stored.kind === 'stored' && stored.value.mathExpression === next.mathExpression) return false;
  settings.set(HOMEY_PRICE_FORMULA, next);
  return true;
};

/**
 * How the mirrored key resolves into something the price build can use.
 *
 * None of these are interchangeable, because they demand different behaviour:
 *
 * - `none` — Homey told us there is no formula, so the raw spot price is
 *   already the owner's price and must be used as-is.
 * - `unknown` — Homey has never answered us (a fresh install, or an upgrade
 *   whose first read has not succeeded), so we do not know how this home prices
 *   electricity. Not the same as `none`, and treating it as `none` is exactly
 *   the bug this file exists to fix.
 * - `unreadable` — the key is there but this read did not produce it. Says
 *   nothing about the home; the next read decides.
 * - `unsupported` — a formula this evaluator cannot reproduce. The owner's real
 *   price is unknowable to us.
 *
 * An unknown price must never be silently replaced by the wholesale value it is
 * derived from, which is always lower than what the owner pays.
 */
export type StoredPriceFormula =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'unreadable' }
  | { kind: 'compiled'; formula: CompiledPriceFormula }
  | { kind: 'unsupported'; expression: string };

export const readStoredPriceFormula = (settings: SettingsPort): StoredPriceFormula => {
  const mirror = readMirror(settings);
  if (mirror.kind === 'absent') return { kind: 'unknown' };
  if (mirror.kind === 'suspect') return { kind: 'unreadable' };
  if (mirror.value.mathExpression === null) return { kind: 'none' };
  const formula = compilePriceFormula(mirror.value.mathExpression);
  return formula
    ? { kind: 'compiled', formula }
    : { kind: 'unsupported', expression: mirror.value.mathExpression };
};

/**
 * Resolve a Homey Energy period series — whose `totalPrice` is the RAW SPOT
 * value Homey published for the period — into the price the owner actually
 * pays, or into a verdict that it cannot be priced at all.
 *
 * ONE function answers both halves of that question, because the caller needs
 * both and they must not be derived twice: the price build takes the periods,
 * and the combined-prices writer takes `unpriceable` as permission to discard
 * what it has persisted. An earlier shape returned a bare array and let the
 * writer re-derive the verdict from the settings key; the two disagreed
 * exactly where it mattered — a formula that compiles but prices nothing
 * (`^` over a negative spot, a `/0` term) yielded an empty series while the
 * re-derivation still answered "priceable", so the writer kept republishing
 * prices built from a formula that no longer prices anything.
 *
 * `unpriceable` is for what we KNOW is wrong, never for what we merely failed
 * to read: an unreadable mirror is `undecided`, which keeps the persisted
 * prices exactly as they are until a later read settles it.
 */
export type HomeyPriceResolution = {
  /** Empty whenever this home cannot be priced; never raw spot in that case. */
  periods: CombinedPricePeriod[];
  /**
   * `priced` — these are the owner's prices.
   * `unpriceable` — we know these prices cannot be produced, so anything
   *   persisted from an older formula is now wrong and must go.
   * `undecided` — a read did not settle it; change nothing.
   */
  verdict: 'priced' | 'unpriceable' | 'undecided';
  reasonCode: 'formula_applied' | 'no_formula' | 'never_read' | 'unreadable_mirror'
    | 'cannot_evaluate' | 'nothing_priced';
};

export const resolveHomeyPriceSeries = (
  periods: CombinedPricePeriod[],
  settings: SettingsPort,
): HomeyPriceResolution => {
  const stored = readStoredPriceFormula(settings);
  if (stored.kind === 'none') {
    return { periods, verdict: 'priced', reasonCode: 'no_formula' };
  }
  if (stored.kind === 'unknown') {
    // Homey has never answered us, so we cannot price — but we also have no
    // basis for calling the prices already persisted wrong. Deleting them here
    // would blank an upgraded install whose first read merely failed, and blank
    // a home the moment its owner picks this price source (the scheme handler
    // rebuilds derived state without reading the route). Price nothing now;
    // decide nothing about what is stored.
    return { periods: [], verdict: 'undecided', reasonCode: 'never_read' };
  }
  if (stored.kind === 'unreadable') {
    return { periods: [], verdict: 'undecided', reasonCode: 'unreadable_mirror' };
  }
  if (stored.kind === 'unsupported') {
    return { periods: [], verdict: 'unpriceable', reasonCode: 'cannot_evaluate' };
  }
  const priced = periods.flatMap((entry) => {
    const totalPrice = stored.formula.evaluate({ spot: entry.totalPrice });
    return totalPrice === null ? [] : [{ ...entry, totalPrice }];
  });
  // A formula that compiles can still price nothing — every period non-finite
  // under it. That is a verdict about the formula, not a gap in the feed.
  if (priced.length === 0 && periods.length > 0) {
    return { periods: [], verdict: 'unpriceable', reasonCode: 'nothing_priced' };
  }
  return { periods: priced, verdict: 'priced', reasonCode: 'formula_applied' };
};

/**
 * Mirror the owner's formula, and say whether the mirror moved.
 *
 * Called on every price refresh — one read per three hours, and the only way
 * PELS learns the formula changed, since Homey publishes no event for it. A
 * failed read changes nothing, so the last known formula keeps pricing; an
 * unchanged one is not rewritten. A `true` answer means the prices this app is
 * holding were built against a formula that no longer applies, which is the
 * caller's cue to rebuild them.
 *
 * This is the EDGE, and so it is where the classification is logged: the price
 * series is rebuilt many times an hour and an uncached per-build log would be a
 * stream, not an event.
 */
export const syncHomeyPriceFormula = async (
  webApiGet: HomeyWebApiGet,
  settings: SettingsPort,
  sinks: PriceServiceLoggingSinks,
): Promise<boolean> => {
  const read = await fetchHomeyPriceFormula(webApiGet);
  const changed = persistHomeyPriceFormula(settings, read);
  const stored = readStoredPriceFormula(settings);
  // A home that cannot be priced has just lost every price feature it has;
  // saying so at warn is the only account the owner's log will carry. `failed`
  // reads are ordinary and stay at debug unless they leave us unable to price.
  if (stored.kind === 'unknown' || stored.kind === 'unsupported') {
    sinks.structuredLog?.warn({
      event: 'homey_price_formula_unpriceable',
      reasonCode: stored.kind === 'unknown' ? 'never_read' : 'cannot_evaluate',
      readKind: read.kind,
      readReasonCode: read.kind === 'failed' ? read.reasonCode : null,
      expression: stored.kind === 'unsupported' ? stored.expression : null,
    });
    return changed;
  }
  if (!changed) {
    sinks.debugStructured({ event: 'homey_price_formula_unchanged', kind: read.kind });
    return false;
  }
  sinks.structuredLog?.info({
    event: 'homey_price_formula_changed',
    kind: read.kind,
    expression: read.kind === 'configured' ? read.expression : null,
  });
  return true;
};

/**
 * Whether an empty rebuild may replace what is already persisted.
 *
 * The combined-prices writer keeps the last good payload when a rebuild comes
 * back empty, because an empty rebuild normally means a raw price slot was
 * missing or briefly unreadable. Only an `unpriceable` verdict overrides that:
 * those prices are not missing but known to be unproducible, so anything
 * persisted from an older formula is now wrong. Warns where it says yes — the
 * home is about to lose every price it has, and this is the account of why.
 */
export const dropsPersistedPrices = (
  resolution: HomeyPriceResolution,
  sinks: PriceServiceLoggingSinks,
): boolean => {
  if (resolution.verdict !== 'unpriceable') return false;
  sinks.structuredLog?.warn({
    event: 'combined_prices_dropped_unpriceable',
    reasonCode: resolution.reasonCode,
  });
  return true;
};
