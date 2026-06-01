import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testExports } from '../src/ui/deadlinesList.ts';
import type {
  DeferredObjectiveActivePlansV1,
  DeferredObjectiveActivePlanV1,
} from '../../contracts/src/deferredObjectiveActivePlans.ts';
import type {
  DeferredObjectiveSettingsV1,
  DeferredObjectiveSettingsEntry,
} from '../../contracts/src/deferredObjectiveSettings.ts';
import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';

const { resolveDeadlinesListCards, resolveDeadlinesHistoryEntries } = testExports;

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 4, 11, 0, 0, 0);

const buildPlan = (overrides: Partial<DeferredObjectiveActivePlanV1>): DeferredObjectiveActivePlanV1 => ({
  deviceId: 'dev_a',
  deviceName: 'Device A',
  objectiveKind: 'temperature',
  targetTemperatureC: 21,
  targetPercent: null,
  deadlineAtMs: T0 + 12 * HOUR_MS,
  startedAtMs: T0,
  pending: false,
  objectiveSignature: 'sig',
  original: null,
  latest: {
    revision: 1,
    revisedAtMs: T0,
    computedFromPricesUpTo: T0 + 24 * HOUR_MS,
    reason: 'flow_card',
    hours: [
      { startsAtMs: T0 + 3 * HOUR_MS, plannedKWh: 2 },
      { startsAtMs: T0 + 4 * HOUR_MS, plannedKWh: 2 },
    ],
    energyNeededKWh: 4,
    planStatus: 'on_track',
  },
  ...overrides,
});

const buildActivePlans = (plans: DeferredObjectiveActivePlanV1[]): DeferredObjectiveActivePlansV1 => ({
  version: 1,
  plansByDeviceId: Object.fromEntries(plans.map((plan) => [plan.deviceId, plan])),
});

const buildObjectiveSettings = (
  entries: Record<string, DeferredObjectiveSettingsEntry>,
): DeferredObjectiveSettingsV1 => ({
  version: 1,
  objectivesByDeviceId: entries,
});

const enabledTemperatureEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC: 21,
  deadlineAtMs: T0 + 12 * HOUR_MS,
};

const enabledEvEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'ev_soc',
  enforcement: 'soft',
  targetPercent: 80,
  deadlineAtMs: T0 + 12 * HOUR_MS,
};

const devices: TargetDeviceSnapshot[] = [
  { id: 'dev_a', name: 'Living-room heater', targets: [], currentOn: false, currentTemperature: 18.4 },
  {
    id: 'dev_b',
    name: 'EV charger',
    targets: [],
    currentOn: false,
    stateOfCharge: { percent: 45, status: 'fresh' },
  },
];

describe('resolveDeadlinesListCards', () => {
  it('returns an empty list when no plans exist', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: { version: 1, plansByDeviceId: {} },
      objectiveSettings: buildObjectiveSettings({}),
      devices,
      nowMs: T0,
    });
    expect(cards).toEqual([]);
  });

  it('returns an empty list when activePlans is null', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: null,
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards).toEqual([]);
  });

  it('assigns building_plan status for pending plans with no latest revision', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({ pending: true, latest: null })]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      deviceId: 'dev_a',
      statusId: 'building_plan',
      firstActionAtMs: null,
    });
  });

  it('assigns building_plan status when latest is null regardless of pending flag', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({ latest: null })]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].statusId).toBe('building_plan');
    expect(cards[0].firstActionAtMs).toBeNull();
  });

  it('skips plans whose objective is disabled in settings', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({})]),
      objectiveSettings: buildObjectiveSettings({
        dev_a: { ...enabledTemperatureEntry, enabled: false },
      }),
      devices,
      nowMs: T0,
    });
    expect(cards).toEqual([]);
  });

  it('builds a card with start/end timestamps and device name from devices payload', () => {
    const nowMs = T0; // first hour at T0 + 3h is in the future
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({})]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      deviceId: 'dev_a',
      deviceName: 'Living-room heater',
      kind: 'temperature',
      targetTemperatureC: 21,
      firstActionAtMs: T0 + 3 * HOUR_MS,
      deadlineAtMs: T0 + 12 * HOUR_MS,
      href: './?page=deadline-plan&deviceId=dev_a',
      statusId: 'queued', // first hour is in the future relative to nowMs
      confidence: null,
      extraPermissionsValue: null,
      currentValueLine: 'currently 18.4 °C',
    });
  });

  it('plumbs smart-task extra permissions onto the card', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({})]),
      objectiveSettings: buildObjectiveSettings({
        dev_a: {
          ...enabledTemperatureEntry,
          rescue: {
            exemptFromBudget: 'always',
            limitLowerPriorityDevices: 'at_risk',
          },
        },
      }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].extraPermissionsValue).toBe(
      'May go over daily budget · May limit lower-priority devices if at risk',
    );
  });

  it('plumbs the per-revision learned-profile confidence band onto the card', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          kwhPerUnitProvenance: {
            source: 'learned',
            kWhPerUnit: 0.55,
            acceptedSamples: 24,
            confidence: 'medium',
            lastAcceptedAtMs: T0,
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].confidence).toBe('medium');
  });

  // Parity with the detail hero's `displayConfidence ?? confidence ?? null`
  // chain (per `resolveChipConfidence`). On settled multi-step thermal
  // devices the raw `confidence` stat sits at `low` forever — the
  // band-aware `displayConfidence` is the value the chip must honour, or
  // the list card keeps saying "Estimating" while the hero correctly
  // stays quiet. Pinning to `high` here exercises the preference: raw
  // `low` would otherwise drive the `Estimating` chip via
  // `formatSmartTaskListConfidenceChipLabel`.
  it('prefers displayConfidence over raw confidence for the chip (hero parity)', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          kwhPerUnitProvenance: {
            source: 'learned',
            kWhPerUnit: 0.55,
            acceptedSamples: 32,
            confidence: 'low',
            displayConfidence: 'high',
            lastAcceptedAtMs: T0,
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].confidence).toBe('high');
  });

  // Bootstrap-silence regression: cold-start cards must keep the chip suppressed
  // (`confidence === null`) so they don't show "Estimating" before the device
  // has any provenance signal at all. The list passes `profileConfidence: null`
  // unconditionally (it doesn't load `objectiveProfiles`), so the only thing
  // standing between the chip and a future regression that re-wires a profile
  // fallback into the list is the producer chain collapsing the three null
  // inputs down to `null`. Sibling of the `displayConfidence > confidence`
  // hero-parity test above — both tests pin the same chain (`resolveChipConfidence`
  // in `deadlinesList.ts`), but this case asserts the silence end of the
  // preference order: nothing in, nothing out.
  it('suppresses the chip when both provenance confidences and live profile are null (cold-start silence)', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          // Bootstrap-shape provenance: no learned profile yet, both confidence
          // fields explicitly null. Plus the list never supplies a live
          // profileConfidence — so all three branches of
          // `displayConfidence ?? confidence ?? profileConfidence` are null and
          // the chain must collapse to `null` (chip suppressed).
          kwhPerUnitProvenance: {
            source: 'bootstrap',
            kWhPerUnit: null,
            acceptedSamples: 0,
            confidence: null,
            displayConfidence: null,
            lastAcceptedAtMs: null,
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].confidence).toBeNull();
  });

  it('formats currently-X line for EV from device state of charge', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          deviceId: 'dev_b',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 80,
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_b: enabledEvEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].currentValueLine).toBe('currently 45 %');
  });

  it('suppresses the currently-X line when the device has no reading yet', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({})]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      // Device exists but has no currentTemperature reading.
      devices: [{ id: 'dev_a', name: 'Living-room heater', targets: [], currentOn: false }],
      nowMs: T0,
    });
    expect(cards[0].currentValueLine).toBeNull();
  });

  it('assigns on_track when first hour has already started', () => {
    const nowMs = T0 + 3 * HOUR_MS + 1; // past first hour start
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({})]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs,
    });
    expect(cards[0].statusId).toBe('on_track');
  });

  it('assigns at_risk when planStatus is at_risk', () => {
    const nowMs = T0 + 5 * HOUR_MS; // past all planned hours
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          latest: {
            revision: 1,
            revisedAtMs: T0,
            computedFromPricesUpTo: T0 + 24 * HOUR_MS,
            reason: 'flow_card',
            hours: [{ startsAtMs: T0 + HOUR_MS, plannedKWh: 1 }],
            energyNeededKWh: 2,
            planStatus: 'at_risk',
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs,
    });
    expect(cards[0].statusId).toBe('at_risk');
  });

  it('assigns cannot_meet when planStatus is cannot_meet', () => {
    const nowMs = T0 + 5 * HOUR_MS;
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          latest: {
            revision: 1,
            revisedAtMs: T0,
            computedFromPricesUpTo: T0 + 24 * HOUR_MS,
            reason: 'flow_card',
            hours: [],
            energyNeededKWh: 4,
            planStatus: 'cannot_meet',
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs,
    });
    expect(cards[0].statusId).toBe('cannot_meet');
  });

  it('assigns satisfied when planStatus is satisfied', () => {
    const nowMs = T0 + 5 * HOUR_MS;
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          latest: {
            revision: 1,
            revisedAtMs: T0,
            computedFromPricesUpTo: T0 + 24 * HOUR_MS,
            reason: 'flow_card',
            hours: [],
            energyNeededKWh: 0,
            planStatus: 'satisfied',
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs,
    });
    expect(cards[0].statusId).toBe('satisfied');
  });

  it('assigns paused_unplugged for EV with invalid_session pending reason', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 80,
          pending: true,
          pendingReason: 'invalid_session',
          latest: null,
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledEvEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].statusId).toBe('paused_unplugged');
  });

  it('assigns paused_unplugged when the EV unplugs mid-plan (diagnosticReasonCode on a non-pending plan)', () => {
    // Mid-plan unplug: the recorder keeps `pending: false` and the cached
    // `latest` revision but refreshes `diagnosticReasonCode` to
    // `objective_invalid_session`. The list chip must reflect that — without
    // this branch the chip would say "On track" while the device-card line
    // says "Charging paused — car unplugged".
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 80,
          pending: false,
          diagnosticReasonCode: 'objective_invalid_session',
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledEvEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].statusId).toBe('paused_unplugged');
  });

  it('resolves the device name by the map key, not by plan.deviceId, so a corrupted record cannot mis-name the card', () => {
    // Persisted plan has `deviceId: 'dev_other'` inside the value, but is stored
    // under key `dev_a`. The card must be named after `dev_a` (the key drives
    // the href + enabled lookup) — using plan.deviceId would link to dev_a
    // while naming it 'Other device', which would mislead the user.
    const plansByDeviceId = {
      dev_a: { ...buildPlan({}), deviceId: 'dev_other', deviceName: 'Stored fallback' },
    };
    const cards = resolveDeadlinesListCards({
      activePlans: { version: 1, plansByDeviceId },
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices: [
        { id: 'dev_a', name: 'Living-room heater', targets: [], currentOn: false },
        { id: 'dev_other', name: 'Other device', targets: [], currentOn: false },
      ],
      nowMs: T0,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].deviceId).toBe('dev_a');
    expect(cards[0].deviceName).toBe('Living-room heater');
    expect(cards[0].href).toBe('./?page=deadline-plan&deviceId=dev_a');
  });

  it('falls back to plan.deviceName when the device is missing from the devices payload', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({ deviceId: 'dev_x', deviceName: 'Fallback' })]),
      objectiveSettings: buildObjectiveSettings({ dev_x: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].deviceName).toBe('Fallback');
  });

  it('sets firstActionAtMs to null when latest has no hours', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          latest: {
            revision: 1,
            revisedAtMs: T0,
            computedFromPricesUpTo: T0 + 24 * HOUR_MS,
            reason: 'flow_card',
            hours: [],
            energyNeededKWh: 0,
            planStatus: 'on_track',
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].firstActionAtMs).toBeNull();
  });

  it('sorts cards by deadline ascending', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          deviceId: 'dev_b',
          deviceName: 'EV charger',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 80,
          deadlineAtMs: T0 + 6 * HOUR_MS,
        }),
        buildPlan({ deviceId: 'dev_a', deadlineAtMs: T0 + 20 * HOUR_MS }),
      ]),
      objectiveSettings: buildObjectiveSettings({
        dev_a: enabledTemperatureEntry,
        dev_b: enabledEvEntry,
      }),
      devices,
      nowMs: T0,
    });
    expect(cards.map((card) => card.deviceId)).toEqual(['dev_b', 'dev_a']);
  });
});

describe('resolveDeadlinesHistoryEntries', () => {
  const buildEntry = (deviceId: string, finalizedAtMs: number) => ({
    deviceId,
    deviceName: deviceId,
    objectiveKind: 'temperature' as const,
    targetTemperatureC: 21,
    targetPercent: null,
    deadlineAtMs: finalizedAtMs,
    startedAtMs: finalizedAtMs - HOUR_MS,
    finalizedAtMs,
    startProgressC: 18,
    startProgressPercent: null,
    finalProgressC: 21,
    finalProgressPercent: null,
    initialEnergyNeededKWh: 2,
    outcome: 'met' as const,
    metAtMs: finalizedAtMs,
    usedDeadlineReserve: false,
    usedPolicyAvoid: false,
    observedIntervals: [],
    discoveredFrom: 'observation' as const,
    id: `entry-${deviceId}-${finalizedAtMs}`,
    originalPlan: null,
    finalPlan: null,
  });

  it('returns an empty list when payload is null', () => {
    expect(resolveDeadlinesHistoryEntries(null)).toEqual([]);
  });

  it('flattens entries across devices, newest finalizedAtMs first', () => {
    const result = resolveDeadlinesHistoryEntries({
      version: 1,
      entriesByDeviceId: {
        dev_a: [buildEntry('dev_a', T0 + 1 * HOUR_MS), buildEntry('dev_a', T0 + 4 * HOUR_MS)],
        dev_b: [buildEntry('dev_b', T0 + 2 * HOUR_MS), buildEntry('dev_b', T0 + 3 * HOUR_MS)],
      },
    });
    expect(result.map((entry) => entry.finalizedAtMs)).toEqual([
      T0 + 4 * HOUR_MS,
      T0 + 3 * HOUR_MS,
      T0 + 2 * HOUR_MS,
      T0 + 1 * HOUR_MS,
    ]);
  });
});

// v2.7.4 — past-tasks device-filter persistence integration (PR-19). Exercises
// the controller round-trip: chip click → localStorage write → next render
// reads the persisted selection. Storage is shared across the suite; each
// test resets both the cache (via `resetDeviceFilterCacheForTests`) and the
// storage key so a stale write from one test can't bleed into another.
describe('history device-filter persistence', () => {
  const {
    HISTORY_DEVICE_FILTER_STORAGE_KEY,
    resetDeviceFilterCacheForTests,
    renderHistorySurface,
  } = testExports;

  const buildHistoryPayloadEntry = (deviceId: string, finalizedAtMs: number, deviceName: string) => ({
    id: `${deviceId}-${finalizedAtMs}`,
    deviceId,
    deviceName,
    objectiveKind: 'temperature' as const,
    targetTemperatureC: 21,
    targetPercent: null,
    deadlineAtMs: finalizedAtMs,
    startedAtMs: finalizedAtMs - HOUR_MS,
    finalizedAtMs,
    startProgressC: 18,
    startProgressPercent: null,
    finalProgressC: 21,
    finalProgressPercent: null,
    initialEnergyNeededKWh: 2,
    outcome: 'met' as const,
    metAtMs: finalizedAtMs,
    usedDeadlineReserve: false,
    usedPolicyAvoid: false,
    observedIntervals: [],
    discoveredFrom: 'observation' as const,
    originalPlan: null,
    finalPlan: null,
  });

  const buildPayload = () => ({
    version: 1 as const,
    entriesByDeviceId: {
      dev_a: [buildHistoryPayloadEntry('dev_a', T0 + 1 * HOUR_MS, 'Boiler')],
      dev_b: [buildHistoryPayloadEntry('dev_b', T0 + 2 * HOUR_MS, 'Connected 300')],
    },
  });

  beforeEach(() => {
    window.localStorage.removeItem(HISTORY_DEVICE_FILTER_STORAGE_KEY);
    resetDeviceFilterCacheForTests();
    document.body.replaceChildren();
  });

  afterEach(() => {
    window.localStorage.removeItem(HISTORY_DEVICE_FILTER_STORAGE_KEY);
    resetDeviceFilterCacheForTests();
    document.body.replaceChildren();
  });

  const mount = (): HTMLElement => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  };

  const findChip = (root: HTMLElement, label: string): HTMLButtonElement | null => (
    Array.from(root.querySelectorAll<HTMLButtonElement>('.deadlines-history__filter-row .plan-chip'))
      .find((chip) => (chip.textContent ?? '').trim() === label) ?? null
  );

  it('persists the selected device id to localStorage when a chip is clicked', () => {
    const surface = mount();
    renderHistorySurface(surface, buildPayload());
    findChip(surface, 'Connected 300')?.click();
    expect(window.localStorage.getItem(HISTORY_DEVICE_FILTER_STORAGE_KEY)).toBe('dev_b');
  });

  it('clears the persisted filter when the active chip is tapped again', () => {
    const surface = mount();
    renderHistorySurface(surface, buildPayload());
    findChip(surface, 'Connected 300')?.click();
    expect(window.localStorage.getItem(HISTORY_DEVICE_FILTER_STORAGE_KEY)).toBe('dev_b');
    // Re-resolve the chip after the re-render so we click the current element.
    findChip(surface, 'Connected 300')?.click();
    expect(window.localStorage.getItem(HISTORY_DEVICE_FILTER_STORAGE_KEY)).toBeNull();
  });

  it('reads the persisted filter on the next render (simulates a reload)', () => {
    window.localStorage.setItem(HISTORY_DEVICE_FILTER_STORAGE_KEY, 'dev_b');
    resetDeviceFilterCacheForTests();
    const surface = mount();
    renderHistorySurface(surface, buildPayload());
    expect(findChip(surface, 'Connected 300')?.getAttribute('aria-pressed')).toBe('true');
    expect(findChip(surface, 'All')?.getAttribute('aria-pressed')).toBe('false');
    // Only Connected 300 rows render — Boiler entries are filtered out.
    const deviceCells = Array.from(
      surface.querySelectorAll<HTMLElement>('.plan-history-card__device'),
    ).map((el) => (el.textContent ?? '').trim());
    expect(deviceCells.every((name) => name === 'Connected 300')).toBe(true);
  });

  it('self-heals when the persisted filter points at a removed device', () => {
    window.localStorage.setItem(HISTORY_DEVICE_FILTER_STORAGE_KEY, 'dev_removed');
    resetDeviceFilterCacheForTests();
    const surface = mount();
    renderHistorySurface(surface, buildPayload());
    // No empty-state copy — the helper falls back to the unfiltered list when
    // the persisted target no longer exists; the chip row drops the dead
    // chip naturally because `resolveSmartTaskHistoryFilterDevices` only
    // enumerates devices that actually have entries.
    const deviceCells = Array.from(
      surface.querySelectorAll<HTMLElement>('.plan-history-card__device'),
    ).map((el) => (el.textContent ?? '').trim());
    expect(deviceCells).toContain('Boiler');
    expect(deviceCells).toContain('Connected 300');
  });
});

// Cost-on-list-rows — REAL state-path regression. pels-ux-fit proved the cost
// was dead-wired: `renderHistorySurface` builds the `DeadlinesHistoryListState`
// but never set `costUnit`, so the empty-string default dropped the cost half of
// every row in production while the component-level tests (which inject
// `costUnit` straight into the view) stayed green. These tests go through the
// actual state-builder so a future un-wiring is caught here. The boot-default
// `CostDisplay` is `{ unit: 'kr', divisor: 100 }` (the Norwegian default
// `resolveCostDisplayFromCombinedPrices` returns), which is exactly what the
// production default-price path threads — so the persisted RAW øre `totalCost`
// must be divided by 100 before it reads as kr. These tests pin BOTH the wiring
// (cost reaches the row) AND the scaling (the divisor is applied), driving the
// production state builder so a future un-wiring OR un-scaling regresses here.
describe('history cost meta line (real state path)', () => {
  const { resetDeviceFilterCacheForTests, renderHistorySurface } = testExports;

  // `totalCost` is the RAW persisted total in the scheme's minor unit (øre for
  // the default kr/100 scheme), exactly as the runtime accumulates it from
  // combined-price totals.
  const buildCostEntry = (totalCost: number, deliveredKWh: number) => ({
    id: `dev_cost-${totalCost}`,
    deviceId: 'dev_cost',
    deviceName: 'Connected 300',
    objectiveKind: 'temperature' as const,
    targetTemperatureC: 65,
    targetPercent: null,
    deadlineAtMs: T0 + 6 * HOUR_MS,
    startedAtMs: T0,
    finalizedAtMs: T0 + 5 * HOUR_MS,
    startProgressC: 50,
    startProgressPercent: null,
    finalProgressC: 65,
    finalProgressPercent: null,
    initialEnergyNeededKWh: 22.5,
    outcome: 'met' as const,
    metAtMs: T0 + 4 * HOUR_MS,
    usedDeadlineReserve: false,
    usedPolicyAvoid: false,
    observedIntervals: [],
    discoveredFrom: 'observation' as const,
    originalPlan: null,
    finalPlan: null,
    totalCost,
    deliveredKWh,
  });

  const buildCostPayload = (totalCost: number, deliveredKWh: number) => ({
    version: 1 as const,
    entriesByDeviceId: {
      dev_cost: [buildCostEntry(totalCost, deliveredKWh)],
    },
  });

  beforeEach(() => {
    resetDeviceFilterCacheForTests();
    document.body.replaceChildren();
  });

  afterEach(() => {
    resetDeviceFilterCacheForTests();
    document.body.replaceChildren();
  });

  const mount = (): HTMLElement => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  };

  it('threads the resolved cost unit into the rendered row (cost is not dead-wired)', () => {
    const surface = mount();
    // 1234 øre @ divisor 100 → ≈ 12 kr.
    renderHistorySurface(surface, buildCostPayload(1234, 18.2));
    const cost = surface.querySelector('.plan-history-card__cost');
    // The cost half renders — proving `costUnit` reaches the row from the state
    // builder, not just when a test injects it into the component.
    expect(cost).not.toBeNull();
    expect(cost?.textContent).toContain('Cost ≈');
    expect(cost?.textContent).toContain('18.2 kWh delivered');
  });

  it('applies the CostDisplay divisor — 150 øre @ divisor 100 reads "≈ 2 kr", not "≈ 150 kr"', () => {
    const surface = mount();
    // The P1 money bug: dropping the divisor labelled raw øre as kr, rendering
    // ~100× too much. 150 øre / 100 = 1.5 → Math.round → 2 kr.
    renderHistorySurface(surface, buildCostPayload(150, 1.5));
    const cost = surface.querySelector('.plan-history-card__cost');
    expect(cost?.textContent).toBe('Cost ≈ 2 kr · 1.5 kWh delivered');
    // Guard the regression direction explicitly: the raw øre figure must NOT
    // appear labelled as kr.
    expect(cost?.textContent).not.toContain('150 kr');
  });

  it('renders the row cost in WHOLE kroner (matches the week-divider rounding)', () => {
    const surface = mount();
    // 1234 øre → 12 kr, not "12.34". The divider above sums the same money and
    // rounds it (Math.round); the row must agree so one screen never shows two
    // precisions for the same figure.
    renderHistorySurface(surface, buildCostPayload(1234, 18.2));
    const cost = surface.querySelector('.plan-history-card__cost');
    expect(cost?.textContent).toBe('Cost ≈ 12 kr · 18.2 kWh delivered');
    expect(cost?.textContent).not.toContain('12.34');
  });

  it('row cost agrees with the week-divider roll-up for the same single-entry data', () => {
    const surface = mount();
    // One entry → its row cost and the week divider's single-entry roll-up are
    // the same money. Both must scale øre→kr identically (divisor applied once
    // each), so the divider heading and the row read the same figure rather
    // than the divider reading raw øre while the row reads kr (or vice-versa).
    renderHistorySurface(surface, buildCostPayload(150, 1.5));
    const rowCost = surface.querySelector('.plan-history-card__cost')?.textContent ?? '';
    const weekHeading = surface.querySelector('.deadlines-history__week')?.textContent ?? '';
    expect(rowCost).toContain('≈ 2 kr');
    expect(weekHeading).toContain('≈ 2 kr');
    // Neither surface labels raw øre as kr.
    expect(rowCost).not.toContain('150 kr');
    expect(weekHeading).not.toContain('150 kr');
  });
});
