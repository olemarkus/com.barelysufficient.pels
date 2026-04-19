import type { Mock } from 'vitest';
import {
  DEVICE_DIAGNOSTICS_STATE_KEY,
  DeviceDiagnosticsService,
} from '../lib/diagnostics/deviceDiagnosticsService';
import type { DeviceDiagnosticsPlanObservation } from '../lib/diagnostics/deviceDiagnosticsService';

type MockSettings = {
  get: Mock;
  set: Mock;
};

const createDeps = (params: { initialState?: unknown; isDebugEnabled?: boolean } = {}) => {
  const { initialState, isDebugEnabled = true } = params;
  const store = new Map<string, unknown>();
  if (initialState !== undefined) {
    store.set(DEVICE_DIAGNOSTICS_STATE_KEY, initialState);
  }
  const settings: MockSettings = {
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
    }),
  };
  const logDebug = vi.fn();
  const structuredInfo = vi.fn();
  const error = vi.fn();
  const service = new DeviceDiagnosticsService({
    homey: { settings } as never,
    getTimeZone: () => 'Europe/Oslo',
    isDebugEnabled: () => isDebugEnabled,
    structuredLog: { info: structuredInfo } as never,
    logDebug,
    error,
  });
  return {
    service,
    store,
    settings,
    logDebug,
    structuredInfo,
    error,
  };
};

const buildObservation = (
  overrides: Partial<DeviceDiagnosticsPlanObservation> = {},
): DeviceDiagnosticsPlanObservation => ({
  deviceId: 'heater-1',
  name: 'Hall Heater',
  includeDemandMetrics: true,
  unmetDemand: true,
  blockCause: 'headroom',
  targetDeficitActive: true,
  desiredStateSummary: '22.0C',
  appliedStateSummary: '18.0C',
  eligibleForStarvation: true,
  currentTemperatureC: 18,
  intendedNormalTargetC: 22,
  targetStepC: 0.5,
  suppressionState: 'counting',
  countingCause: 'capacity',
  pauseReason: null,
  observationFresh: true,
  ...overrides,
});

const getStarvationState = (service: DeviceDiagnosticsService, deviceId = 'heater-1') => (
  ((service as unknown as {
    liveByDeviceId: Record<string, {
      starvation: {
        isStarved: boolean;
        pendingEntryStartedAt?: number;
        clearQualifiedStartedAt?: number;
        starvedAccumulatedMs: number;
        starvationEpisodeStartedAt?: number;
        starvationLastResumedAt?: number;
        starvationCause: string | null;
        starvationPauseReason: string | null;
      };
    }>;
  }).liveByDeviceId[deviceId]?.starvation)
);

const getLiveControlState = (service: DeviceDiagnosticsService, deviceId = 'heater-1') => (
  ((service as unknown as {
    liveByDeviceId: Record<string, {
      openShedTs?: number;
      openRestoreTs?: number;
    }>;
  }).liveByDeviceId[deviceId])
);

describe('DeviceDiagnosticsService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aggregates starvation, hysteresis, and penalty metrics into the UI payload', () => {
    const { service } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (6 * 60 * 1000),
      observations: [buildObservation({
        blockCause: 'cooldown_backoff',
        appliedStateSummary: '19.0C',
        suppressionState: 'paused',
        countingCause: null,
        pauseReason: 'cooldown',
      })],
    });
    service.observePlanSample({
      nowTs: start + (9 * 60 * 1000),
      observations: [buildObservation({
        unmetDemand: false,
        blockCause: 'not_blocked',
        targetDeficitActive: false,
        appliedStateSummary: '22.0C',
        suppressionState: 'paused',
        countingCause: null,
        pauseReason: 'keep',
      })],
    });

    const shedTs = start + (60 * 60 * 1000);
    const restoreTs = shedTs + (20 * 60 * 1000);
    const setbackTs = restoreTs + (5 * 60 * 1000);

    service.recordControlEvent({
      kind: 'pels_shed',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: shedTs,
    });
    service.recordControlEvent({
      kind: 'pels_restore',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: restoreTs,
    });
    service.recordActivationTransition({
      kind: 'attempt_started',
      deviceId: 'heater-1',
      source: 'pels_restore',
      penaltyLevel: 1,
      nowTs: restoreTs,
    }, { name: 'Hall Heater' });
    service.recordActivationTransition({
      kind: 'setback_failed',
      deviceId: 'heater-1',
      source: 'pels_restore',
      previousPenaltyLevel: 1,
      penaltyLevel: 2,
      elapsedMs: 5 * 60 * 1000,
      nowTs: setbackTs,
    }, { name: 'Hall Heater' });
    service.recordControlEvent({
      kind: 'pels_shed',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: setbackTs,
    });

    const payload = service.getUiPayload(setbackTs);
    const summary = payload.diagnosticsByDeviceId['heater-1'];

    expect(summary.currentPenaltyLevel).toBe(2);
    expect(summary.windows['1d']).toMatchObject({
      unmetDemandMs: 9 * 60 * 1000,
      blockedByHeadroomMs: 6 * 60 * 1000,
      blockedByCooldownBackoffMs: 3 * 60 * 1000,
      targetDeficitMs: 9 * 60 * 1000,
      shedCount: 2,
      restoreCount: 1,
      failedActivationCount: 1,
      penaltyBumpCount: 1,
      maxPenaltyLevelSeen: 2,
      minRestoreToSetbackMs: 5 * 60 * 1000,
      maxRestoreToSetbackMs: 5 * 60 * 1000,
    });
    expect(summary.windows['1d'].avgShedToRestoreMs).toBe(20 * 60 * 1000);
    expect(summary.windows['1d'].avgRestoreToSetbackMs).toBe(5 * 60 * 1000);
  });

  it('accepts tracked transitions without counting them as shed or restore actions', () => {
    const { service } = createDeps();
    const start = Date.now();

    service.recordControlEvent({
      kind: 'tracked_usage_drop',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: start,
      fromKw: 3.2,
      toKw: 0.8,
    });
    service.recordControlEvent({
      kind: 'tracked_usage_rise',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: start + (2 * 60 * 1000),
      fromKw: 0.8,
      toKw: 3.2,
    });

    const summary = service.getUiPayload(start + (2 * 60 * 1000)).diagnosticsByDeviceId['heater-1'];
    expect(summary).toMatchObject({
      windows: {
        '1d': expect.objectContaining({
          shedCount: 0,
          restoreCount: 0,
          avgShedToRestoreMs: null,
          avgRestoreToSetbackMs: null,
        }),
      },
    });
  });

  it('records shed-closed activation attempts without counting them as failed activations', () => {
    const { service } = createDeps();
    const start = Date.now();

    service.recordActivationTransition({
      kind: 'attempt_started',
      deviceId: 'heater-1',
      source: 'pels_restore',
      penaltyLevel: 2,
      nowTs: start,
    }, { name: 'Hall Heater' });
    service.recordActivationTransition({
      kind: 'attempt_closed_by_shed',
      deviceId: 'heater-1',
      source: 'pels_restore',
      penaltyLevel: 2,
      elapsedMs: 30_000,
      nowTs: start + 30_000,
    }, { name: 'Hall Heater' });

    const summary = service.getUiPayload(start + 30_000).diagnosticsByDeviceId['heater-1'];
    expect(summary.currentPenaltyLevel).toBe(2);
    expect(summary.windows['1d']).toMatchObject({
      failedActivationCount: 0,
      penaltyBumpCount: 0,
      maxPenaltyLevelSeen: 0,
    });
  });

  it('logs tracked-usage reconciliation tags when present', () => {
    const { service, logDebug } = createDeps();
    const start = Date.now();

    service.recordControlEvent({
      kind: 'tracked_usage_drop',
      reconciliation: 'startup',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: start,
      fromKw: 3.2,
      toKw: 0.8,
    });

    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining(
      'fromKw=3.200 toKw=0.800 reconciliation=startup',
    ));
  });

  it('does not backfill observation gaps larger than ten minutes', () => {
    const { service, logDebug } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (11 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (12 * 60 * 1000),
      observations: [buildObservation({
        unmetDemand: false,
        blockCause: 'not_blocked',
        targetDeficitActive: false,
        appliedStateSummary: '22.0C',
        suppressionState: 'paused',
        countingCause: null,
        pauseReason: 'keep',
      })],
    });

    expect(service.getUiPayload(start + (12 * 60 * 1000)).diagnosticsByDeviceId['heater-1']?.windows['1d'].unmetDemandMs)
      .toBe(60 * 1000);
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('Diagnostics: gap skipped deviceId=heater-1'));
  });

  it('opens and closes PELS control timers only for PELS shed and restore events', () => {
    const { service } = createDeps();
    const shedTs = Date.now();
    const restoreTs = shedTs + (7 * 60 * 1000);

    service.recordControlEvent({
      kind: 'pels_shed',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: shedTs,
    });

    expect(getLiveControlState(service)?.openShedTs).toBe(shedTs);
    expect(getLiveControlState(service)?.openRestoreTs).toBeUndefined();
    expect(service.getUiPayload(shedTs).diagnosticsByDeviceId['heater-1']?.windows['1d']).toMatchObject({
      shedCount: 1,
      restoreCount: 0,
      avgShedToRestoreMs: null,
    });

    service.recordControlEvent({
      kind: 'pels_restore',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: restoreTs,
    });

    expect(getLiveControlState(service)?.openShedTs).toBeUndefined();
    expect(getLiveControlState(service)?.openRestoreTs).toBe(restoreTs);
    expect(service.getUiPayload(restoreTs).diagnosticsByDeviceId['heater-1']?.windows['1d']).toMatchObject({
      shedCount: 1,
      restoreCount: 1,
      avgShedToRestoreMs: 7 * 60 * 1000,
    });
  });

  it('does not let tracked usage drops increment shed counters or touch open shed timers', () => {
    const { service, logDebug } = createDeps();
    const shedTs = Date.now();
    const trackedDropTs = shedTs + (90 * 1000);

    service.recordControlEvent({
      kind: 'pels_shed',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: shedTs,
    });
    service.recordControlEvent({
      kind: 'tracked_usage_drop',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: trackedDropTs,
      fromKw: 3.2,
      toKw: 1.0,
    });

    expect(getLiveControlState(service)?.openShedTs).toBe(shedTs);
    expect(getLiveControlState(service)?.openRestoreTs).toBeUndefined();
    expect(service.getUiPayload(trackedDropTs).diagnosticsByDeviceId['heater-1']?.windows['1d']).toMatchObject({
      shedCount: 1,
      restoreCount: 0,
      avgShedToRestoreMs: null,
      avgRestoreToSetbackMs: null,
    });
    expect(logDebug.mock.calls
      .map(([message]) => message)
      .filter((message): message is string => typeof message === 'string' && message.includes('Diagnostics: shed recorded')))
      .toHaveLength(1);
    expect(logDebug).toHaveBeenCalledWith(
      expect.stringContaining('Diagnostics: tracked usage drop observed deviceId=heater-1'),
    );
  });

  it('measures restore-to-setback only from real PELS events when tracked usage changes intervene', () => {
    const { service } = createDeps();
    const restoreTs = Date.now();
    const trackedDropTs = restoreTs + (10 * 1000);
    const trackedRiseTs = restoreTs + (25 * 1000);
    const pelsShedTs = restoreTs + (5 * 60 * 1000);

    service.recordControlEvent({
      kind: 'pels_restore',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: restoreTs,
    });
    service.recordControlEvent({
      kind: 'tracked_usage_drop',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: trackedDropTs,
      fromKw: 3.0,
      toKw: 0.4,
    });
    service.recordControlEvent({
      kind: 'tracked_usage_rise',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: trackedRiseTs,
      fromKw: 0.4,
      toKw: 3.0,
    });
    service.recordControlEvent({
      kind: 'pels_shed',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: pelsShedTs,
    });

    expect(getLiveControlState(service)?.openShedTs).toBe(pelsShedTs);
    expect(getLiveControlState(service)?.openRestoreTs).toBeUndefined();
    expect(service.getUiPayload(pelsShedTs).diagnosticsByDeviceId['heater-1']?.windows['1d']).toMatchObject({
      shedCount: 1,
      restoreCount: 1,
      avgRestoreToSetbackMs: 5 * 60 * 1000,
      minRestoreToSetbackMs: 5 * 60 * 1000,
      maxRestoreToSetbackMs: 5 * 60 * 1000,
    });
  });

  it('enters starvation only after fifteen minutes of continuous qualifying suppression', () => {
    const { service } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (9 * 60 * 1000),
      observations: [buildObservation()],
    });

    let starvation = getStarvationState(service);
    expect(starvation?.isStarved).toBe(false);
    expect(starvation?.pendingEntryStartedAt).toBe(start);

    service.observePlanSample({
      nowTs: start + (16 * 60 * 1000),
      observations: [buildObservation()],
    });

    starvation = getStarvationState(service);
    expect(starvation?.isStarved).toBe(true);
    expect(starvation?.starvationEpisodeStartedAt).toBe(start + (15 * 60 * 1000));
    expect(starvation?.starvationLastResumedAt).toBe(start + (15 * 60 * 1000));
    expect(starvation?.starvedAccumulatedMs).toBe(60 * 1000);
    expect(starvation?.starvationCause).toBe('capacity');
    expect(starvation?.starvationPauseReason).toBeNull();
  });

  it('pauses and resumes starvation accumulation without counting paused time', () => {
    const { service } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (9 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (16 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (20 * 60 * 1000),
      observations: [buildObservation({
        suppressionState: 'paused',
        countingCause: null,
        pauseReason: 'keep',
      })],
    });
    service.observePlanSample({
      nowTs: start + (25 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (27 * 60 * 1000),
      observations: [buildObservation()],
    });

    const starvation = getStarvationState(service);
    expect(starvation?.isStarved).toBe(true);
    expect(starvation?.starvedAccumulatedMs).toBe(7 * 60 * 1000);
    expect(starvation?.starvationCause).toBe('capacity');
    expect(starvation?.starvationPauseReason).toBeNull();
    expect(starvation?.starvationLastResumedAt).toBe(start + (25 * 60 * 1000));
  });

  it('keeps starvation latched across sample gaps but pauses accumulation', () => {
    const { service } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (9 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (16 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (28 * 60 * 1000),
      observations: [buildObservation()],
    });

    const starvation = getStarvationState(service);
    expect(starvation?.isStarved).toBe(true);
    expect(starvation?.starvedAccumulatedMs).toBe(60 * 1000);
    expect(starvation?.starvationCause).toBe('capacity');
    expect(starvation?.starvationPauseReason).toBeNull();
    expect(starvation?.starvationLastResumedAt).toBe(start + (28 * 60 * 1000));
  });

  it('pauses a latched starvation episode with suppression_none when suppression disappears', () => {
    const { service } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (9 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (16 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (20 * 60 * 1000),
      observations: [buildObservation({
        suppressionState: 'none',
        countingCause: null,
        pauseReason: null,
      })],
    });

    const starvation = getStarvationState(service);
    expect(starvation?.isStarved).toBe(true);
    expect(starvation?.starvedAccumulatedMs).toBe(5 * 60 * 1000);
    expect(starvation?.starvationCause).toBeNull();
    expect(starvation?.starvationPauseReason).toBe('suppression_none');
    expect(starvation?.starvationLastResumedAt).toBeUndefined();
  });

  it('resets pending starvation entry when the intended normal target changes', () => {
    const { service } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (9 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (10 * 60 * 1000),
      observations: [buildObservation({
        intendedNormalTargetC: 24,
        currentTemperatureC: 20,
      })],
    });
    service.observePlanSample({
      nowTs: start + (19 * 60 * 1000),
      observations: [buildObservation({
        intendedNormalTargetC: 24,
        currentTemperatureC: 20,
      })],
    });
    service.observePlanSample({
      nowTs: start + (24 * 60 * 1000),
      observations: [buildObservation({
        intendedNormalTargetC: 24,
        currentTemperatureC: 20,
      })],
    });

    let starvation = getStarvationState(service);
    expect(starvation?.isStarved).toBe(false);
    expect(starvation?.pendingEntryStartedAt).toBe(start + (10 * 60 * 1000));

    service.observePlanSample({
      nowTs: start + (26 * 60 * 1000),
      observations: [buildObservation({
        intendedNormalTargetC: 24,
        currentTemperatureC: 20,
      })],
    });

    starvation = getStarvationState(service);
    expect(starvation?.isStarved).toBe(true);
    expect(starvation?.starvationEpisodeStartedAt).toBe(start + (25 * 60 * 1000));
  });

  it('clears and hard-resets starvation when recovery or eligibility loss criteria are met', () => {
    const { service } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (9 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (16 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (20 * 60 * 1000),
      observations: [buildObservation({
        currentTemperatureC: 21,
      })],
    });
    service.observePlanSample({
      nowTs: start + (29 * 60 * 1000),
      observations: [buildObservation({
        currentTemperatureC: 21,
      })],
    });
    service.observePlanSample({
      nowTs: start + (31 * 60 * 1000),
      observations: [buildObservation({
        currentTemperatureC: 21,
      })],
    });

    let starvation = getStarvationState(service);
    expect(starvation?.isStarved).toBe(false);
    expect(starvation?.starvedAccumulatedMs).toBe(0);

    service.observePlanSample({
      nowTs: start + (40 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (49 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (54 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (56 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (57 * 60 * 1000),
      observations: [buildObservation({
        eligibleForStarvation: false,
        observationFresh: false,
        currentTemperatureC: null,
        intendedNormalTargetC: null,
        targetStepC: null,
        suppressionState: 'none',
        countingCause: null,
        pauseReason: null,
      })],
    });

    starvation = getStarvationState(service);
    expect(starvation?.isStarved).toBe(false);
    expect(starvation?.starvedAccumulatedMs).toBe(0);
    expect(starvation?.starvationEpisodeStartedAt).toBeUndefined();
    expect(starvation?.starvationCause).toBeNull();
    expect(starvation?.starvationPauseReason).toBeNull();
  });

  it('emits structured logs for starvation lifecycle transitions', () => {
    const { service, structuredInfo } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (9 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (16 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (20 * 60 * 1000),
      observations: [buildObservation({
        suppressionState: 'paused',
        countingCause: null,
        pauseReason: 'keep',
      })],
    });
    service.observePlanSample({
      nowTs: start + (25 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (30 * 60 * 1000),
      observations: [buildObservation({
        currentTemperatureC: 21,
      })],
    });
    service.observePlanSample({
      nowTs: start + (40 * 60 * 1000),
      observations: [buildObservation({
        currentTemperatureC: 21,
      })],
    });

    expect(structuredInfo.mock.calls).toEqual([
      [expect.objectContaining({
        event: 'device_starvation_started',
        deviceId: 'heater-1',
        deviceName: 'Hall Heater',
        cause: 'capacity',
        starvationEpisodeStartedAtMs: start + (15 * 60 * 1000),
        starvedDurationMs: 60 * 1000,
      })],
      [expect.objectContaining({
        event: 'device_starvation_paused',
        deviceId: 'heater-1',
        deviceName: 'Hall Heater',
        pauseReason: 'keep',
        transitionAtMs: start + (20 * 60 * 1000),
        starvedDurationMs: 5 * 60 * 1000,
      })],
      [expect.objectContaining({
        event: 'device_starvation_resumed',
        deviceId: 'heater-1',
        deviceName: 'Hall Heater',
        cause: 'capacity',
        transitionAtMs: start + (25 * 60 * 1000),
        starvedDurationMs: 5 * 60 * 1000,
      })],
      [expect.objectContaining({
        event: 'device_starvation_cleared',
        deviceId: 'heater-1',
        deviceName: 'Hall Heater',
        transitionAtMs: start + (40 * 60 * 1000),
        starvedDurationMs: 10 * 60 * 1000,
      })],
    ]);
  });

  it('emits structured hard-reset logs and updates the live starved device count', () => {
    const { service, structuredInfo } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (9 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (16 * 60 * 1000),
      observations: [buildObservation()],
    });

    expect(service.getCurrentStarvedDeviceCount()).toBe(1);

    service.observePlanSample({
      nowTs: start + (18 * 60 * 1000),
      observations: [buildObservation({
        eligibleForStarvation: false,
        observationFresh: false,
        currentTemperatureC: null,
        intendedNormalTargetC: null,
        targetStepC: null,
        suppressionState: 'none',
        countingCause: null,
        pauseReason: null,
      })],
    });

    expect(service.getCurrentStarvedDeviceCount()).toBe(0);
    expect(structuredInfo).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_starvation_hard_reset',
      deviceId: 'heater-1',
      deviceName: 'Hall Heater',
      reasonCode: 'device_no_longer_eligible',
      transitionAtMs: start + (18 * 60 * 1000),
      starvedDurationMs: 3 * 60 * 1000,
      wasStarved: true,
    }));
  });

  it('counts only starved devices observed in the latest plan sample', () => {
    const { service } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (9 * 60 * 1000),
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: start + (16 * 60 * 1000),
      observations: [buildObservation()],
    });

    expect(service.getCurrentStarvedDeviceCount()).toBe(1);

    service.observePlanSample({
      nowTs: start + (17 * 60 * 1000),
      observations: [],
    });

    expect(service.getCurrentStarvedDeviceCount()).toBe(0);

    service.observePlanSample({
      nowTs: start + (18 * 60 * 1000),
      observations: [buildObservation({
        deviceId: 'heater-2',
        name: 'Bedroom Heater',
      })],
    });

    expect(service.getCurrentStarvedDeviceCount()).toBe(0);
  });

  it('repairs invalid persisted payloads and prunes expired day buckets', () => {
    const versionMismatch = createDeps({
      initialState: {
      version: 1,
      windowDays: 21,
      generatedAt: 0,
      devicesById: {},
      },
    });

    expect(versionMismatch.settings.set).toHaveBeenCalledWith(
      DEVICE_DIAGNOSTICS_STATE_KEY,
      expect.objectContaining({ version: 2 }),
    );
    expect(versionMismatch.logDebug).toHaveBeenCalledWith(
      expect.stringContaining('Diagnostics: reset persisted payload reason="version mismatch'),
    );

    const validOldState = {
      version: 2,
      windowDays: 21,
      generatedAt: Date.now(),
      devicesById: {
        'heater-1': {
          daysByDateKey: {
            '2026-02-01': {
              unmetDemandMs: 123,
              blockedByHeadroomMs: 123,
              blockedByCooldownBackoffMs: 0,
              targetDeficitMs: 123,
              shedCount: 0,
              restoreCount: 0,
              failedActivationCount: 0,
              stableActivationCount: 0,
              shedToRestoreCount: 0,
              shedToRestoreTotalMs: 0,
              restoreToSetbackCount: 0,
              restoreToSetbackTotalMs: 0,
              restoreToSetbackMinMs: null,
              restoreToSetbackMaxMs: null,
              penaltyBumpCount: 0,
              penaltyMaxLevelSeen: 0,
            },
            '2026-03-09': {
              unmetDemandMs: 456,
              blockedByHeadroomMs: 456,
              blockedByCooldownBackoffMs: 0,
              targetDeficitMs: 456,
              shedCount: 0,
              restoreCount: 0,
              failedActivationCount: 0,
              stableActivationCount: 0,
              shedToRestoreCount: 0,
              shedToRestoreTotalMs: 0,
              restoreToSetbackCount: 0,
              restoreToSetbackTotalMs: 0,
              restoreToSetbackMinMs: null,
              restoreToSetbackMaxMs: null,
              penaltyBumpCount: 0,
              penaltyMaxLevelSeen: 0,
            },
          },
        },
      },
    };

    const pruned = createDeps({ initialState: validOldState });
    expect(pruned.logDebug).toHaveBeenCalledWith(expect.stringContaining('Diagnostics: pruned expired days count=1'));
    const payload = pruned.service.getUiPayload(Date.now());
    expect(payload.diagnosticsByDeviceId['heater-1']?.windows['21d'].unmetDemandMs).toBe(456);
  });

  it('repairs invalid primitive persisted payloads', () => {
    const invalid = createDeps({ initialState: 'broken-payload' });

    expect(invalid.settings.set).toHaveBeenCalledWith(
      DEVICE_DIAGNOSTICS_STATE_KEY,
      expect.objectContaining({ version: 2, devicesById: {} }),
    );
    expect(invalid.logDebug).toHaveBeenCalledWith(
      expect.stringContaining('Diagnostics: reset persisted payload reason="invalid persisted payload"'),
    );
  });

  it('splits unmet-demand spans across local day boundaries', () => {
    const { service } = createDeps();
    const start = Date.parse('2026-03-09T22:58:00.000Z');
    const end = Date.parse('2026-03-09T23:03:00.000Z');

    service.observePlanSample({
      nowTs: start,
      observations: [buildObservation()],
    });
    service.observePlanSample({
      nowTs: end,
      observations: [buildObservation({
        unmetDemand: false,
        blockCause: 'not_blocked',
        targetDeficitActive: false,
        appliedStateSummary: '22.0C',
        suppressionState: 'paused',
        countingCause: null,
        pauseReason: 'keep',
      })],
    });

    const payload = service.getUiPayload(end);
    expect(payload.diagnosticsByDeviceId['heater-1']?.windows['1d'].unmetDemandMs).toBe(3 * 60 * 1000);
    expect(payload.diagnosticsByDeviceId['heater-1']?.windows['7d'].unmetDemandMs).toBe(5 * 60 * 1000);
  });

  it('throttles repeated diagnostics persistence writes within the flush window', () => {
    const { service, settings } = createDeps();
    const start = Date.now();

    service.recordControlEvent({
      nowTs: start,
      kind: 'pels_shed',
      deviceId: 'heater-1',
    });
    vi.runOnlyPendingTimers();
    expect(settings.set).toHaveBeenCalledTimes(1);

    const secondTs = start + (60 * 1000);
    vi.setSystemTime(new Date(secondTs));
    service.recordControlEvent({
      nowTs: secondTs,
      kind: 'pels_restore',
      deviceId: 'heater-1',
    });

    vi.advanceTimersByTime((4 * 60 * 1000) - 1);
    expect(settings.set).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(start + (5 * 60 * 1000)));
    vi.advanceTimersByTime(1);
    expect(settings.set).toHaveBeenCalledTimes(2);
  });

  it('unrefs throttled flush timers so diagnostics persistence does not block process exit', () => {
    vi.useRealTimers();
    const unref = vi.fn();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((handler: TimerHandler) => {
      void handler;
      return { unref } as never;
    }) as typeof setTimeout);

    try {
      const { service } = createDeps();
      service.recordControlEvent({
        nowTs: Date.UTC(2026, 2, 9, 10, 0, 0),
        kind: 'pels_shed',
        deviceId: 'heater-1',
      });

      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-09T10:00:00.000Z'));
    }
  });

  it('skips persisted payload serialization in flush logs when diagnostics debug is disabled', () => {
    const { service, logDebug } = createDeps({ isDebugEnabled: false });
    const stringifySpy = vi.spyOn(JSON, 'stringify');

    try {
      service.recordControlEvent({
        nowTs: Date.UTC(2026, 2, 9, 10, 0, 0),
        kind: 'pels_shed',
        deviceId: 'heater-1',
      });

      vi.runOnlyPendingTimers();

      expect(stringifySpy).not.toHaveBeenCalled();
      const flushMessage = logDebug.mock.calls
        .map(([message]) => message)
        .find((message): message is string => typeof message === 'string' && message.includes('Diagnostics: flushed'));
      expect(flushMessage).toBeDefined();
      expect(flushMessage).not.toContain('bytes=');
    } finally {
      stringifySpy.mockRestore();
    }
  });

  it('records activation transitions by deviceId even when no fresh name is provided', () => {
    const { service } = createDeps();
    const nowTs = Date.now();

    service.recordActivationTransition({
      kind: 'attempt_started',
      deviceId: 'heater-1',
      source: 'pels_restore',
      penaltyLevel: 1,
      nowTs,
    }, {});
    service.recordActivationTransition({
      kind: 'setback_failed',
      deviceId: 'heater-1',
      source: 'pels_restore',
      previousPenaltyLevel: 1,
      penaltyLevel: 2,
      elapsedMs: 60_000,
      nowTs: nowTs + 60_000,
    }, {});

    const payload = service.getUiPayload(nowTs + 60_000);
    expect(payload.diagnosticsByDeviceId['heater-1']).toMatchObject({
      currentPenaltyLevel: 2,
      windows: {
        '1d': expect.objectContaining({
          failedActivationCount: 1,
          penaltyBumpCount: 1,
          maxPenaltyLevelSeen: 2,
        }),
      },
    });
  });
});
