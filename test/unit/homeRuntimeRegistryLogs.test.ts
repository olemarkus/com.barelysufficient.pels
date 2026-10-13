// Unit tests for the home-runtime registry's structured-log emitters
// (`lib/home/homeRuntimeRegistryLogs.ts`). These are pure functions over an
// injected logger: log audits key on the event names and `detail` wording, so
// the point of the test is that each condition keeps emitting the documented
// event at the documented level — and that a missing `homes` logger is a
// silent no-op rather than a throw on a diagnostics-only path.
import { describe, expect, it, vi } from 'vitest';
import type { Logger as PinoLogger } from '../../lib/logging/logger';
import {
  logBundleReplacementFailure,
  logHomeReadFailed,
  logHomeScopedSettingForUnknownHome,
  logIncompleteIdentityTransition,
  logPowerSourceTransitionIncomplete,
  logSubHomesUnderFlowSource,
} from '../../lib/home/homeRuntimeRegistryLogs';

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const asLogger = (logger: ReturnType<typeof createLogger>): PinoLogger => logger as unknown as PinoLogger;

const home = { homeId: 'cabin', name: 'Cabin', meterDeviceId: 'meter-1', rootZoneId: 'zone-1' };

describe('homeRuntimeRegistryLogs', () => {
  it('warns that sub-home meters are never sampled under the flow power source', () => {
    const logger = createLogger();
    logSubHomesUnderFlowSource(asLogger(logger), 2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatchObject({
      event: 'sub_homes_configured_under_flow_power_source',
      subHomeCount: 2,
    });
  });

  it('debug-logs an unknown home id as transient, never as an error', () => {
    const logger = createLogger();
    logHomeScopedSettingForUnknownHome(asLogger(logger), 'cabin', 'power_tracker_state');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug.mock.calls[0][0]).toMatchObject({
      event: 'home_scoped_setting_for_unknown_home',
      homeId: 'cabin',
      baseKey: 'power_tracker_state',
    });
  });

  it('warns — never errors — when a per-home UI read is classified as unavailable', () => {
    const logger = createLogger();
    logHomeReadFailed(asLogger(logger), 'cabin', new Error('plan serialization failed'));
    // A read the producer already classified is not a fault: the consumer was
    // told `unavailable` and rendered "no data for this home".
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).toMatchObject({
      event: 'home_runtime_read_failed',
      homeId: 'cabin',
    });
  });

  it('warns on a failed durable freshness reset during a meter-identity swap', () => {
    const logger = createLogger();
    logIncompleteIdentityTransition(asLogger(logger), home);
    expect(logger.warn.mock.calls[0][0]).toMatchObject({
      event: 'home_meter_identity_transition_incomplete',
      homeId: 'cabin',
      meterDeviceId: 'meter-1',
    });
  });

  it('errors with the normalized cause when a bundle replacement throws', () => {
    const logger = createLogger();
    logBundleReplacementFailure(asLogger(logger), home, new Error('boom'));
    const payload = logger.error.mock.calls[0][0];
    expect(payload).toMatchObject({ event: 'home_meter_identity_transition_incomplete', homeId: 'cabin' });
    expect(payload.err).toBeDefined();
  });

  it('separates the two power-source transition failures by level and detail', () => {
    const logger = createLogger();
    logPowerSourceTransitionIncomplete(
      asLogger(logger),
      { generation: 3, powerSource: 'homey_energy', cause: 'freshness_reset' },
    );
    logPowerSourceTransitionIncomplete(
      asLogger(logger),
      { generation: 4, powerSource: 'flow', cause: 'bundle_replacement', error: new Error('nope') },
    );

    expect(logger.warn.mock.calls[0][0]).toMatchObject({
      event: 'home_power_source_transition_incomplete',
      generation: 3,
      detail: expect.stringContaining('durable meter freshness reset failed'),
    });
    expect(logger.error.mock.calls[0][0]).toMatchObject({
      event: 'home_power_source_transition_incomplete',
      generation: 4,
      detail: expect.stringContaining('bundle replacement failed'),
    });
  });

  it('is a no-op when the homes logger is unavailable', () => {
    expect(() => {
      logSubHomesUnderFlowSource(undefined, 1);
      logHomeScopedSettingForUnknownHome(undefined, 'cabin', 'capacity_limit_kw');
      logIncompleteIdentityTransition(undefined, home);
      logBundleReplacementFailure(undefined, home, new Error('boom'));
      logPowerSourceTransitionIncomplete(undefined, { generation: 1, powerSource: 'flow', cause: 'freshness_reset' });
      logPowerSourceTransitionIncomplete(
        undefined,
        { generation: 2, powerSource: 'flow', cause: 'bundle_replacement', error: new Error('x') },
      );
    }).not.toThrow();
  });
});
