/**
 * Boundary resolver + copy for the per-home Limits status card (multi-home U3).
 *
 * The card reads the meter area's live status blob (`pels_status:<homeId>`),
 * which the runtime writes as the full PelsStatus shape (`lib/plan/pelsStatus.ts`).
 * That blob is untrusted settings data, so this module shape-guards it into a
 * strongly-typed, resolved value at the boundary (AGENTS.md validation rule):
 * finiteness-gate every number, express absence as flat `null`, and never let a
 * raw `NaN`/partial object reach the view. The view then renders the resolved
 * value without re-checking provenance.
 *
 * Copy stays in the canonical vocabulary (notes/ui-terminology.md): "Power now",
 * "Hard cap", "Simulating"/"Active", "limit" (never shed/restore). Under
 * simulation the state line stays hypothetical ("would limit …"), because PELS
 * acts on nothing while simulating.
 *
 * The state line also honours the producer's `limitReason`: `devicesOff` counts
 * transient restore/settling holds, but those carry `limitReason: 'none'`, so
 * the line attributes a hold to the cap ONLY for a capacity-driven reason —
 * never turning a momentary cooldown into "Limiting … to stay under the cap."
 */

import { formatHomeDeviceCount } from './homesManagementCopy';

export type HomeLimitsPosture = 'simulating' | 'active';

export type HomeLimitsChipTone = 'ok' | 'warn';

/**
 * Why the plan is holding devices back this cycle — mirrors the producer's
 * `limitReason` (`lib/plan/pelsStatus.ts`). Crucially, transient restore/
 * settling holds count in `devicesOff` but resolve to `'none'`, so the state
 * line must NOT attribute a `'none'` hold to the cap.
 */
export type HomeLimitsLimitReason = 'none' | 'hourly' | 'daily' | 'both';

export type HomeLimitsStatus = {
  /**
   * Simulation vs active control — the EFFECTIVE actuation posture from the
   * blob's `dryRunEffective` (membership-gated), falling back to the meter
   * area's persisted dry-run setting before a blob exists.
   */
  posture: HomeLimitsPosture;
  /** Total draw now (managed + background), or null when no live sample exists. */
  powerNowKw: number | null;
  /** The configured hard cap for this meter area (from its own setting). */
  hardCapKw: number | null;
  /** Controllable devices the plan is holding back; null when the blob omits it. */
  limitedDeviceCount: number | null;
  /** Why devices are held — governs whether the state line names the cap. */
  limitReason: HomeLimitsLimitReason;
  /** Every managed device is already limited and the area is still over the cap. */
  shortfall: boolean;
  /** Whether any status blob was found at all (false = area hasn't planned yet). */
  hasStatus: boolean;
};

// ── Copy ─────────────────────────────────────────────────────────────────────

export const HOME_LIMITS_STATUS_TITLE = 'Status now';
export const HOME_LIMITS_STATUS_POWER_NOW_LABEL = 'Power now';
export const HOME_LIMITS_STATUS_HARD_CAP_LABEL = 'Hard cap';

export const HOME_LIMITS_STATUS_CHIP_SIMULATING = 'Simulating';
export const HOME_LIMITS_STATUS_CHIP_ACTIVE = 'Active';

/** No status blob yet — a freshly created area that hasn't produced a plan. */
export const HOME_LIMITS_STATUS_PENDING = 'PELS hasn’t reported on this meter area yet.';
/**
 * A blob exists but carries no live power reading (`powerNowKw` absent
 * false). PELS can't claim it is under the cap without a current draw, so the
 * calm active-idle line is withheld until a reading lands.
 */
export const HOME_LIMITS_STATUS_AWAITING_READING = 'Waiting for a live power reading on this meter area.';
export const HOME_LIMITS_STATUS_SIMULATING_IDLE = 'Simulating — devices are left as they are.';
export const HOME_LIMITS_STATUS_ACTIVE_IDLE = 'Within the cap — not limiting any devices.';
export const HOME_LIMITS_STATUS_SHORTFALL
  = 'Can’t stay under the cap — every managed device here is already limited.';

// ── Boundary guards ──────────────────────────────────────────────────────────

const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
);

const toFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

/** A device count is only trustworthy as a non-negative safe integer. */
const toSafeCount = (value: unknown): number | null => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
);

const LIMIT_REASONS: ReadonlySet<string> = new Set(['none', 'hourly', 'daily', 'both']);

/** Discriminate the untrusted `limitReason` into the recognized enum, else null. */
const toLimitReason = (value: unknown): HomeLimitsLimitReason | null => (
  typeof value === 'string' && LIMIT_REASONS.has(value) ? (value as HomeLimitsLimitReason) : null
);

const isCapLimitReason = (reason: HomeLimitsLimitReason): boolean => (
  reason === 'hourly' || reason === 'both'
);

const isRealLimitReason = (reason: HomeLimitsLimitReason): boolean => (
  reason !== 'none'
);

// ── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Shape the raw `pels_status:<homeId>` blob into the typed status the card
 * renders. `dryRun` and `hardCapKw` come from the meter area's own scalar
 * settings (always known), so the posture chip and cap stat render even before
 * the area has produced a status blob.
 */
export const resolveHomeLimitsStatus = (
  raw: unknown,
  input: { dryRun: boolean; hardCapKw: number | null },
): HomeLimitsStatus => {
  const record = asRecord(raw);
  // Posture reflects the EFFECTIVE actuation state, not just the persisted
  // dry-run intent. The runtime writes `dryRunEffective` (the membership-gated
  // `getCapacityDryRun()` the bundle acts on) into the blob, so a home that is
  // persisted-live but has no committed zone tree (R7b) still reads Simulating.
  // Fall back to the persisted intent when the blob predates the field or hasn't
  // arrived yet (the honest best guess before the first plan).
  const effectiveDryRun = record !== null && typeof record.dryRunEffective === 'boolean'
    ? record.dryRunEffective
    : input.dryRun;
  const posture: HomeLimitsPosture = effectiveDryRun ? 'simulating' : 'active';
  const pending: HomeLimitsStatus = {
    posture,
    powerNowKw: null,
    hardCapKw: input.hardCapKw,
    limitedDeviceCount: null,
    limitReason: 'none',
    shortfall: false,
    hasStatus: false,
  };
  if (record === null) return pending;

  // A trustworthy blob carries BOTH a non-negative safe-integer device count and
  // a recognized limit reason (the runtime always writes both). If either is
  // junk — `{}`, `{devicesOff:'junk'}`, negative/fractional/huge, unknown reason
  // — the blob is malformed: render the pending/unknown state rather than a
  // confident "Within the cap." over garbage.
  const limitedDeviceCount = toSafeCount(record.devicesOff);
  const limitReason = toLimitReason(record.limitReason);
  if (limitedDeviceCount === null || limitReason === null) return pending;

  const controlledKw = toFiniteNumber(record.controlledKw);
  const uncontrolledKw = toFiniteNumber(record.uncontrolledKw);
  // Prefer the whole-area meter total the blob carries: a meter area can report
  // a live total while per-device attribution (controlledKw/uncontrolledKw) is
  // absent, in which case the parts sum is null but a real draw exists. Fall back
  // to summing the parts only when the total is missing. Gate the COMPUTED sum
  // too: two large finite operands can overflow to Infinity, which must read as
  // "unknown", never "Infinity kW".
  const partsSumKw = controlledKw !== null && uncontrolledKw !== null
    ? toFiniteNumber(controlledKw + uncontrolledKw)
    : null;
  const totalKw = toFiniteNumber(record.totalKw) ?? partsSumKw;
  // "Power now" is the producer's own resolved figure (`powerNowKw`,
  // `planBuilderMeta`), displayed as given. It used to be recomposed here from
  // `powerKnown && hasLivePowerSample && totalKw !== null &&
  // Number.isFinite(totalKw)` — the consumer-side provenance branch the root
  // AGENTS.md rule forbids, and one that could render `—` for a blob that
  // carried the canonical value, because the resolved figure was consulted as a
  // presence flag rather than shown.
  //
  // `hasLivePowerSample` was redundant in that chain: `powerKnown` was
  // `freshness === 'fresh' && total !== null`, which already implied it. The
  // finiteness checks were NOT — they survive above. The read of
  // `record.totalKw` is untrusted input off the settings store, and the parts sum
  // is a COMPUTED value two finite operands can overflow (`MAX_VALUE +
  // MAX_VALUE` → Infinity, which must read as unknown, never "Infinity kW"), so
  // that gate lives where the sum is made.
  const resolvedKw = toFiniteNumber(record.powerNowKw);
  // LEGACY BLOBS ONLY: those written before `powerNowKw` existed (2026-08-08)
  // carry the `powerKnown` flag and the composed total instead. Kept so an
  // upgrade does not blank the card until the next status write, and because the
  // parts-sum fallback above is documented behaviour for a meter area with
  // attribution but no total. Both can go once no persisted blob predates the
  // field.
  const legacyKw = record.powerKnown === true ? totalKw : null;
  const powerNowKw = resolvedKw ?? legacyKw;
  return {
    posture,
    powerNowKw,
    hardCapKw: input.hardCapKw,
    limitedDeviceCount,
    limitReason,
    shortfall: record.capacityShortfall === true,
    hasStatus: true,
  };
};

// ── Status-derived copy ──────────────────────────────────────────────────────

export const resolveHomeLimitsPostureChip = (
  status: HomeLimitsStatus,
): { label: string; tone: HomeLimitsChipTone } => (
  status.posture === 'simulating'
    ? { label: HOME_LIMITS_STATUS_CHIP_SIMULATING, tone: 'warn' }
    : { label: HOME_LIMITS_STATUS_CHIP_ACTIVE, tone: 'ok' }
);

/**
 * One outcome-oriented state line. Hypothetical while simulating.
 *
 * `devicesOff` counts transient restore/settling holds (restore-cooldown,
 * meter-settling, restore-throttled/-pending, startup) as well as real cap
 * limits, but the producer marks those transient holds `limitReason: 'none'`.
 * So the line names the cap ONLY for a capacity-driven reason ('hourly'/'both'),
 * a daily-budget reason names the budget, and a 'none' hold reads as a momentary
 * "resuming shortly" — never a false "Limiting … to stay under the cap."
 */
export const composeHomeLimitsStateLine = (status: HomeLimitsStatus): string => {
  if (!status.hasStatus) return HOME_LIMITS_STATUS_PENDING;
  const count = status.limitedDeviceCount ?? 0;
  if (status.posture === 'simulating') {
    // In simulation PELS acts on nothing; only a real cap/budget limit is worth
    // stating hypothetically — a transient hold reads "left as they are".
    return count > 0 && isRealLimitReason(status.limitReason)
      ? `Simulating — would limit ${formatHomeDeviceCount(count)}.`
      : HOME_LIMITS_STATUS_SIMULATING_IDLE;
  }
  if (status.shortfall) return HOME_LIMITS_STATUS_SHORTFALL;
  if (count === 0) {
    // "Within the cap" is a compliance claim — only honest with a current draw.
    // Without a live reading (`powerNowKw` null: no sample / stale / overflow),
    // say we're waiting for one rather than asserting the area is under the cap.
    return status.powerNowKw === null ? HOME_LIMITS_STATUS_AWAITING_READING : HOME_LIMITS_STATUS_ACTIVE_IDLE;
  }
  if (isCapLimitReason(status.limitReason)) {
    return `Limiting ${formatHomeDeviceCount(count)} to stay under the cap.`;
  }
  if (status.limitReason === 'daily') {
    return `Limiting ${formatHomeDeviceCount(count)} to stay within today’s daily budget.`;
  }
  return `Holding ${formatHomeDeviceCount(count)} for a moment — resuming shortly.`;
};

/** Format a kW figure for a stat cell; the placeholder dash when unknown. */
export const formatHomeLimitsKw = (kw: number | null): string => (
  kw === null ? '—' : `${kw.toFixed(1)} kW`
);
