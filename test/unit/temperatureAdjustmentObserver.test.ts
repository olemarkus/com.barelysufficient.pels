import { describe, expect, it } from 'vitest';
import { TemperatureAdjustmentObserver } from '../../lib/device/temperatureAdjustmentObserver';

describe('external temperature attribution', () => {
  it('keeps the latest PELS command attributable beyond the short transport echo window', () => {
    const observer = new TemperatureAdjustmentObserver();
    observer.recordCommand('heater', 18, 0);
    expect(observer.observe('heater', 18, 600_000)).toBeUndefined();
    expect(observer.observe('heater', 22, 600_000)).toEqual({
      deviceId: 'heater', temperature: 22, observedAtMs: 600_000,
    });
  });

  it('keeps a long-held setpoint attributable after a new command supersedes it', () => {
    const observer = new TemperatureAdjustmentObserver();
    observer.recordCommand('heater', 18, 0);
    observer.recordCommand('heater', 23, 600_000);
    expect(observer.observe('heater', 18, 606_000)).toBeUndefined();
  });

  it('recognises reordered echoes from multiple commands without blocking another device', () => {
    const observer = new TemperatureAdjustmentObserver();
    observer.recordCommand('heater', 18, 0);
    observer.recordCommand('heater', 23, 1000);
    expect(observer.observe('heater', 18, 10_000)).toBeUndefined();
    expect(observer.observe('heater', 23, 10_000)).toBeUndefined();
    expect(observer.observe('other', 18, 10_000)?.temperature).toBe(18);
  });
});
