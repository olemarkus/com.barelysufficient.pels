import {
  DEVICE_DIAGNOSTICS_STATE_KEY,
  DeviceDiagnosticsService,
} from '../lib/diagnostics/deviceDiagnosticsService';

type MockSettings = {
  get: jest.Mock;
  set: jest.Mock;
};

const createDeps = (params: { initialState?: unknown; isDebugEnabled?: boolean } = {}) => {
  const { initialState, isDebugEnabled = true } = params;
  const store = new Map<string, unknown>();
  if (initialState !== undefined) {
    store.set(DEVICE_DIAGNOSTICS_STATE_KEY, initialState);
  }
  const settings: MockSettings = {
    get: jest.fn((key: string) => store.get(key)),
    set: jest.fn((key: string, value: unknown) => {
      store.set(key, value);
    }),
  };
  const logDebug = jest.fn();
  const error = jest.fn();
  const service = new DeviceDiagnosticsService({
    homey: { settings } as never,
    getTimeZone: () => 'Europe/Oslo',
    isDebugEnabled: () => isDebugEnabled,
    logDebug,
    error,
  });
  return {
    service,
    store,
    settings,
    logDebug,
    error,
  };
};

describe('DeviceDiagnosticsService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-09T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('aggregates starvation, hysteresis, and penalty metrics into the UI payload', () => {
    const { service } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [{
        deviceId: 'heater-1',
        name: 'Hall Heater',
        includeDemandMetrics: true,
        unmetDemand: true,
        blockCause: 'headroom',
        targetDeficitActive: true,
        desiredStateSummary: '22.0C',
        appliedStateSummary: '18.0C',
      }],
    });
    service.observePlanSample({
      nowTs: start + (6 * 60 * 1000),
      observations: [{
        deviceId: 'heater-1',
        name: 'Hall Heater',
        includeDemandMetrics: true,
        unmetDemand: true,
        blockCause: 'cooldown_backoff',
        targetDeficitActive: true,
        desiredStateSummary: '22.0C',
        appliedStateSummary: '19.0C',
      }],
    });
    service.observePlanSample({
      nowTs: start + (9 * 60 * 1000),
      observations: [{
        deviceId: 'heater-1',
        name: 'Hall Heater',
        includeDemandMetrics: true,
        unmetDemand: false,
        blockCause: 'not_blocked',
        targetDeficitActive: false,
        desiredStateSummary: '22.0C',
        appliedStateSummary: '22.0C',
      }],
    });

    const shedTs = start + (60 * 60 * 1000);
    const restoreTs = shedTs + (20 * 60 * 1000);
    const setbackTs = restoreTs + (5 * 60 * 1000);

    service.recordControlEvent({
      kind: 'shed',
      origin: 'pels',
      deviceId: 'heater-1',
      name: 'Hall Heater',
      nowTs: shedTs,
    });
    service.recordControlEvent({
      kind: 'restore',
      origin: 'pels',
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
      kind: 'shed',
      origin: 'pels',
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

  it('does not backfill observation gaps larger than ten minutes', () => {
    const { service, logDebug } = createDeps();
    const start = Date.now();

    service.observePlanSample({
      nowTs: start,
      observations: [{
        deviceId: 'heater-1',
        includeDemandMetrics: true,
        unmetDemand: true,
        blockCause: 'headroom',
        targetDeficitActive: true,
        desiredStateSummary: '22.0C',
        appliedStateSummary: '18.0C',
      }],
    });
    service.observePlanSample({
      nowTs: start + (11 * 60 * 1000),
      observations: [{
        deviceId: 'heater-1',
        includeDemandMetrics: true,
        unmetDemand: true,
        blockCause: 'headroom',
        targetDeficitActive: true,
        desiredStateSummary: '22.0C',
        appliedStateSummary: '18.0C',
      }],
    });
    service.observePlanSample({
      nowTs: start + (12 * 60 * 1000),
      observations: [{
        deviceId: 'heater-1',
        includeDemandMetrics: true,
        unmetDemand: false,
        blockCause: 'not_blocked',
        targetDeficitActive: false,
        desiredStateSummary: '22.0C',
        appliedStateSummary: '22.0C',
      }],
    });

    expect(service.getUiPayload(start + (12 * 60 * 1000)).diagnosticsByDeviceId['heater-1']?.windows['1d'].unmetDemandMs)
      .toBe(60 * 1000);
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('Diagnostics: gap skipped deviceId=heater-1'));
  });

  it('repairs invalid persisted payloads and prunes expired day buckets', () => {
    const versionMismatch = createDeps({
      initialState: {
      version: 0,
      windowDays: 21,
      generatedAt: 0,
      devicesById: {},
      },
    });

    expect(versionMismatch.settings.set).toHaveBeenCalledWith(
      DEVICE_DIAGNOSTICS_STATE_KEY,
      expect.objectContaining({ version: 1 }),
    );
    expect(versionMismatch.logDebug).toHaveBeenCalledWith(
      expect.stringContaining('Diagnostics: reset persisted payload reason="version mismatch'),
    );

    const validOldState = {
      version: 1,
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
      expect.objectContaining({ version: 1, devicesById: {} }),
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
      observations: [{
        deviceId: 'heater-1',
        includeDemandMetrics: true,
        unmetDemand: true,
        blockCause: 'headroom',
        targetDeficitActive: true,
        desiredStateSummary: '22.0C',
        appliedStateSummary: '18.0C',
      }],
    });
    service.observePlanSample({
      nowTs: end,
      observations: [{
        deviceId: 'heater-1',
        includeDemandMetrics: true,
        unmetDemand: false,
        blockCause: 'not_blocked',
        targetDeficitActive: false,
        desiredStateSummary: '22.0C',
        appliedStateSummary: '22.0C',
      }],
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
      kind: 'shed',
      origin: 'pels',
      deviceId: 'heater-1',
    });
    jest.runOnlyPendingTimers();
    expect(settings.set).toHaveBeenCalledTimes(1);

    const secondTs = start + (60 * 1000);
    jest.setSystemTime(new Date(secondTs));
    service.recordControlEvent({
      nowTs: secondTs,
      kind: 'restore',
      origin: 'pels',
      deviceId: 'heater-1',
    });

    jest.advanceTimersByTime((4 * 60 * 1000) - 1);
    expect(settings.set).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date(start + (5 * 60 * 1000)));
    jest.advanceTimersByTime(1);
    expect(settings.set).toHaveBeenCalledTimes(2);
  });

  it('unrefs throttled flush timers so diagnostics persistence does not block process exit', () => {
    jest.useRealTimers();
    const unref = jest.fn();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((handler: TimerHandler) => {
      void handler;
      return { unref } as never;
    }) as typeof setTimeout);

    try {
      const { service } = createDeps();
      service.recordControlEvent({
        nowTs: Date.UTC(2026, 2, 9, 10, 0, 0),
        kind: 'shed',
        origin: 'pels',
        deviceId: 'heater-1',
      });

      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-03-09T10:00:00.000Z'));
    }
  });

  it('skips persisted payload serialization in flush logs when diagnostics debug is disabled', () => {
    const { service, logDebug } = createDeps({ isDebugEnabled: false });
    const stringifySpy = jest.spyOn(JSON, 'stringify');

    try {
      service.recordControlEvent({
        nowTs: Date.UTC(2026, 2, 9, 10, 0, 0),
        kind: 'shed',
        origin: 'pels',
        deviceId: 'heater-1',
      });

      jest.runOnlyPendingTimers();

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
});
