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

  it('takes the device\'s rounded setpoint soon after a command as its answer, not the owner\'s choice', () => {
    // A heater that only takes whole degrees answers PELS's 20.5 °C with 21 °C on its next poll.
    const observer = new TemperatureAdjustmentObserver();
    observer.recordCommand('heater', 20.5, 0);
    expect(observer.observe('heater', 20.5, 15_000)).toBeUndefined();
    expect(observer.observe('heater', 21, 300_000)).toBeUndefined();
    // Anything after that answer is the owner's, or another app's.
    expect(observer.observe('heater', 23, 600_000)).toEqual({
      deviceId: 'heater', temperature: 23, observedAtMs: 600_000,
    });
  });

  it('takes a setpoint a degree or more off, or long after the command, as an adjustment', () => {
    const observer = new TemperatureAdjustmentObserver();
    observer.recordCommand('heater', 18, 0);
    expect(observer.observe('heater', 19, 60_000)?.temperature).toBe(19);
    observer.recordCommand('heater', 18, 0);
    expect(observer.observe('heater', 18.5, 16 * 60_000)?.temperature).toBe(18.5);
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
