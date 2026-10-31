import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContinuousBatteryPlanService } from '../../lib/battery/continuousBatteryPlanService';
import type { ContinuousBatteryPlanSource } from '../../lib/ports/continuousBatteryPlan';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { ContinuousBatteryPlanWaitReason } from '../../packages/contracts/src/continuousBatteryPlan';
import {
  CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY,
  DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG,
} from '../../packages/shared-domain/src/settings/continuousBatteryPlan';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

const EVENT = 'battery_plan_status_changed';

const settings: SettingsPort = {
  get: key => (key === CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY
    ? { battery: { ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, priceUnit: 'EUR/kWh' } }
    : null),
  set: () => {},
  unset: () => {},
  getKeys: () => [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY],
};

const waitingSource = (reason: { current: ContinuousBatteryPlanWaitReason }): ContinuousBatteryPlanSource => ({
  getNowMs: () => Date.parse('2026-10-27T00:00:00Z'),
  readHorizon: () => ({ kind: 'waiting', reason: reason.current }),
});

describe('battery plan status log', () => {
  let capture: LoggerCapture;
  beforeEach(() => { capture = captureLogger('debug', ['price']); });
  afterEach(() => { capture.restore(); });

  it('logs a waiting reason once, and again only when it changes', async () => {
    const reason: { current: ContinuousBatteryPlanWaitReason } = { current: 'prices_unavailable' };
    const owner = new ContinuousBatteryPlanService(settings, waitingSource(reason));

    owner.read('battery');
    owner.read('battery');
    await new Promise(resolve => setImmediate(resolve));
    expect(capture.findEvents(EVENT)).toHaveLength(1);
    expect(capture.findEvent(EVENT)).toMatchObject({
      deviceId: 'battery', status: 'waiting', reason: 'prices_unavailable',
      previousStatus: null, previousReason: null,
    });

    reason.current = 'battery_unavailable';
    owner.read('battery');
    owner.read('battery');
    await new Promise(resolve => setImmediate(resolve));
    const events = capture.findEvents(EVENT);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      status: 'waiting', reason: 'battery_unavailable',
      previousStatus: 'waiting', previousReason: 'prices_unavailable',
    });
  });
});
