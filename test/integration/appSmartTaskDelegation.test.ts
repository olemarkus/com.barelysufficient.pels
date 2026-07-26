/**
 * The smart-task surface `PelsApp` exposes to the widget host API and the
 * settings-UI handlers is a set of thin stubs delegating to two collaborators
 * (`setup/appSmartTaskApi.ts` for the write/preview lanes,
 * `setup/appSmartTaskPayloads.ts` for the read payloads). A stub wired to the
 * wrong collaborator, or to the wrong method, would compile and fail silently —
 * these assert each one reaches the intended body through the real app object.
 *
 * Only the two deferred-objective recorders (the outward seam) are stubbed; the
 * app instance and both collaborators are real.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type {
  DeferredObjectiveActivePlansV1,
  DeferredObjectiveActivePlanV1,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryV4,
} from '../../packages/contracts/src/deferredObjectivePlanHistory';
import { cleanupApps, createApp } from '../utils/appTestUtils';

const DEVICE_ID = 'dev-1';

const buildActivePlan = (): DeferredObjectiveActivePlanV1 => ({
  deviceId: DEVICE_ID,
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: 5_000,
  startedAtMs: 1_000,
  pending: false,
  objectiveSignature: 'sig-1',
  original: null,
  latest: null,
});

const buildHistoryEntry = (
  overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
): DeferredObjectivePlanHistoryEntry => ({
  id: 'entry-1',
  deviceId: DEVICE_ID,
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: 5_000,
  startedAtMs: 1_000,
  finalizedAtMs: 4_000,
  startProgressC: 40,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 2,
  outcome: 'met',
  metAtMs: 3_900,
  usedDeadlineReserve: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
  ...overrides,
});

const buildAppWithRecorders = (options: {
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  history?: DeferredObjectivePlanHistoryV4;
} = {}) => {
  const app = createApp();
  app.deferredObjectiveActivePlanRecorder = {
    getActivePlansSnapshot: () => options.activePlans ?? null,
  };
  app.deferredObjectivePlanHistoryRecorder = {
    getHistorySnapshot: () => options.history,
    getInProgressTrajectory: () => null,
  };
  return app;
};

afterEach(async () => {
  await cleanupApps();
});

describe('PelsApp smart-task delegation stubs', () => {
  it('routes getDeferredObjectiveActivePlansUiPayload to the payload assembler', () => {
    const app = buildAppWithRecorders({
      activePlans: { version: 1, plansByDeviceId: { [DEVICE_ID]: buildActivePlan() } },
    });
    const payload = app.getDeferredObjectiveActivePlansUiPayload();
    // The resolved (unit-agnostic) view is the assembler's output, not the raw snapshot.
    expect(payload?.plansByDeviceId[DEVICE_ID]?.targetValue).toBe(65);
  });

  it('returns null from getDeferredObjectiveActivePlansUiPayload when no snapshot exists', () => {
    expect(buildAppWithRecorders().getDeferredObjectiveActivePlansUiPayload()).toBeNull();
  });

  it('routes getDeferredObjectivePlanHistoryUiPayload to the unbounded history payload', () => {
    const app = buildAppWithRecorders({
      history: {
        version: 4,
        entries: [buildHistoryEntry({ id: 'old', finalizedAtMs: 1_000 }), buildHistoryEntry({ id: 'new' })],
      },
    });
    const payload = app.getDeferredObjectivePlanHistoryUiPayload();
    expect(payload.entriesByDeviceId[DEVICE_ID].map((entry: { id: string }) => entry.id))
      .toEqual(['new', 'old']);
  });

  it('routes getDeferredObjectivePlanHistoryRecentUiPayload to the BOUNDED variant', () => {
    // The bounded stub must not resolve to the unbounded one: the stale entry
    // proves the `sinceMs` cutoff was actually applied.
    const app = buildAppWithRecorders({
      history: {
        version: 4,
        entries: [buildHistoryEntry({ id: 'stale', finalizedAtMs: 1_000 }), buildHistoryEntry({ id: 'recent' })],
      },
    });
    const payload = app.getDeferredObjectivePlanHistoryRecentUiPayload(3_000);
    expect(payload.entriesByDeviceId[DEVICE_ID].map((entry: { id: string }) => entry.id)).toEqual(['recent']);
  });

  it('routes hasDeferredObjectiveForDevice to the open-task store predicate', () => {
    // No objective is persisted for this device in the mock settings store.
    expect(buildAppWithRecorders().hasDeferredObjectiveForDevice(DEVICE_ID)).toBe(false);
  });
});

describe('AppSmartTaskApi boot-window invariants', () => {
  // `AppContext` types `dailyBudgetService` optional while `PelsApp` declares it
  // definite, so the `?.getSnapshot() ?? null` that came across from `app.ts`
  // turned from vestigial into load-bearing on extraction. `getSnapshot()`
  // legitimately returns `null`, so defaulting would make "no daily budget" and
  // "service not wired yet" indistinguishable and let a preview quote an
  // estimate that silently ignores a configured budget. Per `setup/AGENTS.md`,
  // an extracted body re-asserts a boot-window invariant by throwing.
  //
  // The window is real: `startApp` runs `initPriceCoordinator` before
  // `initDailyBudgetService`. Reproduce exactly that — price coordinator wired,
  // daily budget not — so the assertion is proven on its own and not by whichever
  // sibling read the preview's object literal happens to evaluate first.
  it('throws instead of previewing against a defaulted daily-budget snapshot', () => {
    const app = buildAppWithRecorders();
    app.priceCoordinator = {
      getPriceUnitLabel: () => 'NOK/kWh',
      getPriceOptimizationEnabled: () => false,
    };
    expect(app.dailyBudgetService).toBeUndefined();
    expect(() => app.previewDeferredObjectivePlan(DEVICE_ID, {
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 65,
      deadlineAtMs: 5_000,
    })).toThrow(/DailyBudgetService must be initialized/);
  });
});
