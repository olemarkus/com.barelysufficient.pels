import { describe, expect, it } from 'vitest';
import { TemperatureAdjustmentObserver } from '../../lib/device/temperatureAdjustmentObserver';
import { captureLogger } from '../utils/loggerCapture';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/ports/controlCommandConfirmation';

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

describe('timed-out temperature command evidence', () => {
  it.each(['superseded', 'removed', 'expired'] as const)('does not correlate a %s attempt', (caseName) => {
    const logs = captureLogger('info', []);
    try {
      const observer = new TemperatureAdjustmentObserver();
      const attempt = observer.recordCommand('heater', 18, 0);
      observer.recordTimeout('heater', attempt, 'attempt', 'transaction', 15_000, true);
      if (caseName === 'superseded') {
        observer.recordCommand('heater', 18, 20_000);
      }
      if (caseName === 'removed') observer.retainDevices(new Set());
      observer.observeTimedOutCommand({
        deviceId: 'heater',
        setting: 'temperature',
        value: 18,
        reportedAtMs: caseName === 'expired' ? CONTROL_COMMAND_CONFIRMATION_MS : 22_000,
      });
      expect(logs.findEvent('target_command_observed_after_timeout')).toBeUndefined();
    } finally {
      logs.restore();
    }
  });

  it('matches an exact late echo after a newer command times out', () => {
    const logs = captureLogger('info', []);
    try {
      const observer = new TemperatureAdjustmentObserver();
      const first = observer.recordCommand('heater', 18, 0);
      observer.recordTimeout('heater', first, 'first', 'tx-1', 15_000, true);
      const retry = observer.recordCommand('heater', 18, 30_000);
      observer.recordTimeout('heater', retry, 'retry', 'tx-2', 45_000, true);

      observer.observeTimedOutEcho('heater', 'tx-1', 46_000);
      expect(logs.findEvent('target_command_echoed_after_timeout')).toMatchObject({
        targetCommandId: 'first', transactionId: 'tx-1',
      });
      observer.observeTimedOutEcho('heater', 'tx-1', CONTROL_COMMAND_CONFIRMATION_MS);
      expect(logs.findEvents('target_command_echoed_after_timeout')).toHaveLength(1);
    } finally {
      logs.restore();
    }
  });
});
