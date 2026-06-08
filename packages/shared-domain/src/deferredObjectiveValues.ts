// Single source of truth for resolving the unit-agnostic numeric value out of a
// deferred objective's kind-split (°C vs %) field pair.
//
// A deferred objective records each target/progress reading in one of two
// columns depending on `objectiveKind` — temperature runs use the `*C` column
// and EV-SoC runs use the `*Percent` column, with the other column `null`. The
// value itself is the SAME planning quantity in both cases (energy =
// ratePerUnit × (target − current)); only the display unit differs. Consumers
// must therefore never branch on `objectiveKind` to pick which column holds the
// number — they call one of these resolvers. `objectiveKind` stays in play only
// where a human-facing unit suffix ("°C" / "%") is rendered, never to select a
// value.
//
// Coalesce order is `*Percent ?? *C`. Given the invariant that at most one
// column of a pair is non-null per record (the writer seeds only the kind's
// column), the order is irrelevant for correctness today and matches the
// existing `objectiveKind === 'temperature' ? *C : *Percent` fork value for
// value. The order is also forward-compatible with the planned single-column
// write (every kind writing `*Percent`): a temperature entry that only sets
// `*Percent` resolves identically, while legacy temperature entries that only
// set `*C` still resolve via the `?? *C` fallback.

// Fields are optional (`?:`) so the resolvers serve both the persisted history
// entry (columns typed `number | null`) and the active-plan trajectory (some
// columns optional, i.e. may be absent / `number | null | undefined`). The
// trailing `?? null` normalizes a missing/undefined pair back to `null` so the
// return stays `number | null`.
export type DeferredObjectiveTargetFields = {
  targetTemperatureC?: number | null;
  targetPercent?: number | null;
};

export type DeferredObjectiveStartProgressFields = {
  startProgressC?: number | null;
  startProgressPercent?: number | null;
};

export type DeferredObjectiveFinalProgressFields = {
  finalProgressC?: number | null;
  finalProgressPercent?: number | null;
};

export type DeferredObjectiveSampleValueFields = {
  valueC?: number | null;
  valuePercent?: number | null;
};

export const resolveTargetValue = (
  fields: DeferredObjectiveTargetFields,
): number | null => fields.targetPercent ?? fields.targetTemperatureC ?? null;

export const resolveStartProgressValue = (
  fields: DeferredObjectiveStartProgressFields,
): number | null => fields.startProgressPercent ?? fields.startProgressC ?? null;

export const resolveFinalProgressValue = (
  fields: DeferredObjectiveFinalProgressFields,
): number | null => fields.finalProgressPercent ?? fields.finalProgressC ?? null;

export const resolveSampleValue = (
  fields: DeferredObjectiveSampleValueFields,
): number | null => fields.valuePercent ?? fields.valueC ?? null;
