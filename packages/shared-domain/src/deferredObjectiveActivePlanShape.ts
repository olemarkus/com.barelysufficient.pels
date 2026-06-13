// Single source of truth for the TOP-LEVEL shape/version guard of the persisted
// `deferred_objective_active_plans` setting. Two surfaces normalise this blob:
//
//   • the runtime recorder (`lib/objectives/deferredObjectives/activePlanSettings.ts`,
//     `normalizeDeferredObjectiveActivePlans`) — deep per-device validation, and
//   • the settings UI (`packages/settings-ui/src/ui/deferredObjectiveActivePlans.ts`,
//     `coerceDeferredObjectiveActivePlans`) — a narrow Overview view.
//
// Both used to hand-roll the same envelope check (raw is an object → has a
// recognised `version` → `plansByDeviceId` is an object → keep the valid
// per-device entries). The UI copy quietly diverged: it hard-coded `version: 1`,
// skipped the version check, and did NO per-device filtering — benign today
// (consumers optional-chain each leaf) but a latent bug the moment the version
// literal bumps, since the UI would force `version: 1` onto a v2 payload and
// render foreign fields. This module hoists the envelope into ONE browser-safe
// place per the resolution-in-producer rule; each surface supplies its own
// per-device predicate (deep vs narrow) and its own empty fallback.
//
// shared-domain is browser-safe and must not import `lib/**`, so the version
// literal also lives here (it previously lived runtime-side) — it is a plain
// constant with no runtime dependency.

export const DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION = 1 as const;

// The persisted envelope, generic over the per-device plan shape each surface
// keeps. `version` is the recognised literal on both the runtime and UI views.
export type DeferredObjectiveActivePlansEnvelope<TPlan> = {
  version: typeof DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION;
  plansByDeviceId: Record<string, TPlan>;
};

// Each surface keeps its own return type via the `TEmpty` fallback inferred from
// `empty()`: the runtime passes `createEmptyActivePlans` (so the union collapses
// to a concrete, never-null envelope) and the UI passes `() => null` (so it may
// get `null` back). One implementation, no overloads.
export function normalizeDeferredObjectiveActivePlansShape<TPlan, TEmpty>(
  raw: unknown,
  options: {
    // Per-device validity predicate. Runtime passes its deep `isActivePlan`;
    // the settings UI passes a narrow object-shape check. Entries failing it are
    // dropped — the per-device filtering the UI side previously skipped.
    isValidPlan: (plan: unknown) => plan is TPlan;
    // The value returned when the blob is absent/malformed/version-mismatched.
    // Runtime returns a fresh empty envelope; the UI returns `null`.
    empty: () => TEmpty;
  },
): DeferredObjectiveActivePlansEnvelope<TPlan> | TEmpty {
  // `typeof [] === 'object'`, so reject arrays explicitly at both levels: an array
  // `plansByDeviceId` would otherwise `Object.entries` into numeric-key ('0','1')
  // pseudo-deviceIds instead of degrading to `empty()`.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return options.empty();
  const r = raw as Record<string, unknown>;
  if (r.version !== DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION) return options.empty();
  if (!r.plansByDeviceId || typeof r.plansByDeviceId !== 'object' || Array.isArray(r.plansByDeviceId)) {
    return options.empty();
  }
  const entries = Object.entries(r.plansByDeviceId as Record<string, unknown>)
    .filter((entry): entry is [string, TPlan] => options.isValidPlan(entry[1]));
  return {
    version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
    plansByDeviceId: Object.fromEntries(entries),
  };
}
