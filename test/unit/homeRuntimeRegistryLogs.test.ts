// Unit tests for the home-runtime registry's structured-log emitters
// (`setup/homeRuntime/homeRuntimeRegistryLogs.ts`). These are pure functions
// over an injected logger: log audits key on the event names and `detail`
// wording, so the point of the test is that each condition keeps emitting the
// documented event at the documented level — and that a missing `homes` logger
// is a silent no-op rather than a throw on a diagnostics-only path.
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../lib/app/appContext';
import {
  logBundleReplacementFailure,
  logHomeScopedSettingForUnknownHome,
  logIncompleteIdentityTransition,
  logPowerSourceTransitionIncomplete,
  logSubHomesUnderFlowSource,
} from '../../setup/homeRuntime/homeRuntimeRegistryLogs';

// Scope-aware on purpose: every emitter must route to the `homes` component.
// A stub that ignored the argument would keep passing if an emitter silently
// moved to another logger scope, which is exactly what log audits key on.
const createCtx = (logger: unknown) => ({
  getStructuredLogger: (component: string) => (component === 'homes' ? logger : undefined),
} as unknown as AppContext);

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const home = { homeId: 'cabin', name: 'Cabin', meterDeviceId: 'meter-1', rootZoneId: 'zone-1' };

describe('homeRuntimeRegistryLogs', () => {
  it('warns that sub-home meters are never sampled under the flow power source', () => {
    const logger = createLogger();
    logSubHomesUnderFlowSource(createCtx(logger), 2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatchObject({
      event: 'sub_homes_configured_under_flow_power_source',
      subHomeCount: 2,
    });
  });

  it('debug-logs an unknown home id as transient, never as an error', () => {
    const logger = createLogger();
    logHomeScopedSettingForUnknownHome(createCtx(logger), 'cabin', 'power_tracker_state');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug.mock.calls[0][0]).toMatchObject({
      event: 'home_scoped_setting_for_unknown_home',
      homeId: 'cabin',
      baseKey: 'power_tracker_state',
    });
  });

  it('warns on a failed durable freshness reset during a meter-identity swap', () => {
    const logger = createLogger();
    logIncompleteIdentityTransition(createCtx(logger), home);
    expect(logger.warn.mock.calls[0][0]).toMatchObject({
      event: 'home_meter_identity_transition_incomplete',
      homeId: 'cabin',
      meterDeviceId: 'meter-1',
    });
  });

  it('errors with the normalized cause when a bundle replacement throws', () => {
    const logger = createLogger();
    logBundleReplacementFailure(createCtx(logger), home, new Error('boom'));
    const payload = logger.error.mock.calls[0][0];
    expect(payload).toMatchObject({ event: 'home_meter_identity_transition_incomplete', homeId: 'cabin' });
    expect(payload.err).toBeDefined();
  });

  it('separates the two power-source transition failures by level and detail', () => {
    const logger = createLogger();
    logPowerSourceTransitionIncomplete(
      createCtx(logger),
      { generation: 3, powerSource: 'homey_energy', cause: 'freshness_reset' },
    );
    logPowerSourceTransitionIncomplete(
      createCtx(logger),
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
    const ctx = createCtx(undefined);
    expect(() => {
      logSubHomesUnderFlowSource(ctx, 1);
      logHomeScopedSettingForUnknownHome(ctx, 'cabin', 'capacity_limit_kw');
      logIncompleteIdentityTransition(ctx, home);
      logBundleReplacementFailure(ctx, home, new Error('boom'));
      logPowerSourceTransitionIncomplete(ctx, { generation: 1, powerSource: 'flow', cause: 'freshness_reset' });
      logPowerSourceTransitionIncomplete(
        ctx,
        { generation: 2, powerSource: 'flow', cause: 'bundle_replacement', error: new Error('x') },
      );
    }).not.toThrow();
  });
});
