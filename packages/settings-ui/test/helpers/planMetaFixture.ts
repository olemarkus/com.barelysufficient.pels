import type {
  SettingsUiPlanMetaMeasuredFields,
  SettingsUiPlanMetaSnapshot,
  SettingsUiPlanMetaSnapshotBase,
} from '../../../contracts/src/settingsUiApi.ts';

/**
 * A complete `SettingsUiPlanMetaSnapshot`, so a spec spells only the numbers its
 * assertion is about.
 *
 * The plan meta is REQUIRED almost throughout: the planner writes every one of
 * these on every cycle, and saying so in the type is what lets the hero stop
 * re-checking them. Specs had been sending `{ totalKw, softLimitKw, headroomKw }`
 * and relying on the rest being optional — which stopped being true, and stopped
 * being *safe*: with the guards gone, a payload missing `hardCapLimitKw` no
 * longer degrades to a hidden tick, it throws inside `formatKw`.
 *
 * The defaults describe an unremarkable on-track hour: 4.2 kW drawn against a
 * 9.5 kW pace under a 12 kW cap, capacity-bound, fresh sample, no daily budget.
 * A spec asserting on any of that should pass it explicitly rather than lean on
 * these numbers.
 */
export const buildPlanMeta = (
  overrides: Partial<SettingsUiPlanMetaSnapshotBase & SettingsUiPlanMetaMeasuredFields> = {},
): SettingsUiPlanMetaSnapshot => ({
  ...buildPlanMetaBase(overrides),
  powerIsMeasured: true,
  controlledKw: 2,
  uncontrolledKw: 2.2,
  ...overrides,
});

/**
 * The UNMEASURED wire meta: the silent-meter fail-closed cycle. The base
 * fields and the bare signal — no headroom, no managed/background split —
 * because the planner publishes none for it, and the hero draws nothing.
 */
export const buildUnmeasuredPlanMeta = (
  overrides: Partial<SettingsUiPlanMetaSnapshotBase> = {},
): SettingsUiPlanMetaSnapshot => ({
  ...buildPlanMetaBase(overrides),
  powerIsMeasured: false,
});

const buildPlanMetaBase = (
  overrides: Partial<SettingsUiPlanMetaSnapshotBase>,
): SettingsUiPlanMetaSnapshotBase => ({
  totalKw: 4.2,
  lastPowerUpdateMs: Date.UTC(2026, 3, 18, 10, 0, 0),
  softLimitKw: 9.5,
  capacitySoftLimitKw: 9.5,
  budgetPaceKw: null,
  projectedExemptKw: null,
  softLimitSource: 'capacity',
  hardCapLimitKw: 12,
  usedKWh: 1.2,
  hourBudgetKWh: 9.5,
  minutesRemaining: 30,
  ...overrides,
});
