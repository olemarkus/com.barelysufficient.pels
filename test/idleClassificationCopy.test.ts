import { formatIdleClassificationCopy } from '../packages/shared-domain/src/idleClassificationCopy';

describe('formatIdleClassificationCopy', () => {
  it('builds a neutral status line for near_target_idle with temperatures', () => {
    const copy = formatIdleClassificationCopy({
      classification: 'near_target_idle',
      currentTemperatureC: 61.5,
      targetTemperatureC: 65,
    });
    expect(copy.tone).toBe('neutral');
    expect(copy.statusLine).toBe('Holding near setpoint (61.5° / 65°)');
    expect(copy.detail).toContain('61.5° / 65°');
  });

  it('builds a warning status line for unresponsive with temperatures', () => {
    const copy = formatIdleClassificationCopy({
      classification: 'unresponsive',
      currentTemperatureC: 55,
      targetTemperatureC: 65,
    });
    expect(copy.tone).toBe('warning');
    expect(copy.statusLine).toBe('Not responding (55° / 65°)');
    expect(copy.detail).toContain('breaker');
  });

  it('degrades gracefully when temperatures are missing', () => {
    const copy = formatIdleClassificationCopy({ classification: 'near_target_idle' });
    expect(copy.statusLine).toBe('Holding near setpoint');
    expect(copy.detail).not.toContain('undefined');
  });

  it('does not recommend raising the capacity cap', () => {
    const copy = formatIdleClassificationCopy({
      classification: 'unresponsive',
      currentTemperatureC: 50,
      targetTemperatureC: 70,
    });
    expect(copy.detail.toLowerCase()).not.toMatch(/hard cap|raise/);
  });
});
