import { formatIdleClassificationCopy } from '../../lib/observer/idleClassificationCopy';
import {
  classificationImpliesStallSatisfied,
  stallEvidenceCoversTarget,
} from '../../lib/objectives/stallEvidence';

describe('classificationImpliesStallSatisfied', () => {
  it('accepts the near-target band while an internal device cap remains unmet', () => {
    expect(classificationImpliesStallSatisfied('near_target_idle')).toBe(true);
    expect(classificationImpliesStallSatisfied('capped_idle')).toBe(false);
  });

  it('never treats a fault or the absence of a classification as satisfied', () => {
    expect(classificationImpliesStallSatisfied('unresponsive')).toBe(false);
    expect(classificationImpliesStallSatisfied(undefined)).toBe(false);
  });
});

describe('stallEvidenceCoversTarget', () => {
  const parkedAt = (classifiedAgainstTargetValue: number, temperatureGapC = 0) => ({
    classification: 'near_target_idle' as const,
    classifiedAgainstTargetValue,
    temperatureGapC,
  });

  it('accepts a heating verdict measured against a setpoint at or above the task target', () => {
    expect(stallEvidenceCoversTarget(parkedAt(65), 65, 'increasing')).toBe(true);
    expect(stallEvidenceCoversTarget(parkedAt(70), 65, 'increasing')).toBe(true);
  });

  // The production failure: PELS parks a device by writing a lower setback
  // setpoint, the device idles there, and the verdict reads `near_target_idle`
  // without a single kWh delivered toward the task's own target.
  it('refuses a heating verdict measured against a setback below the task target', () => {
    expect(stallEvidenceCoversTarget(parkedAt(40), 65, 'increasing')).toBe(false);
  });

  it('checks cooling evidence against the lower task target', () => {
    expect(stallEvidenceCoversTarget(parkedAt(22), 22, 'decreasing')).toBe(true);
    expect(stallEvidenceCoversTarget(parkedAt(20), 22, 'decreasing')).toBe(true);
    expect(stallEvidenceCoversTarget(parkedAt(25), 22, 'decreasing')).toBe(false);
    expect(stallEvidenceCoversTarget(parkedAt(22, -3), 22, 'decreasing')).toBe(false);
  });

  it('refuses to infer target coverage when progress direction is unknown', () => {
    expect(stallEvidenceCoversTarget(parkedAt(65), 65, 'unknown')).toBe(false);
  });

  // Only the objective's target is nullable — an objective can lack one. The
  // verdict setpoint is not: `getStallEvidence` withholds evidence it cannot
  // resolve, so there is no null-setpoint case left to test here.
  it('refuses when there is no objective target, or no verdict at all', () => {
    expect(stallEvidenceCoversTarget(parkedAt(65), null, 'increasing')).toBe(false);
    expect(stallEvidenceCoversTarget(undefined, 65, 'increasing')).toBe(false);
  });

  it('still refuses a fault verdict however high the setpoint was', () => {
    expect(stallEvidenceCoversTarget(
      { classification: 'unresponsive', classifiedAgainstTargetValue: 90, temperatureGapC: 0 },
      65,
      'increasing',
    )).toBe(false);
  });
});

describe('formatIdleClassificationCopy', () => {
  it('builds a neutral status line for near_target_idle with temperatures', () => {
    const copy = formatIdleClassificationCopy({
      classification: 'near_target_idle',
      currentTemperatureC: 61.5,
      targetTemperatureC: 65,
    });
    expect(copy.tone).toBe('neutral');
    expect(copy.statusLine).toBe('Holding near setpoint (61.5 °C / 65 °C)');
    expect(copy.detail).toContain('61.5 °C / 65 °C');
  });

  it('builds an understated status line for unresponsive with temperatures', () => {
    const copy = formatIdleClassificationCopy({
      classification: 'unresponsive',
      currentTemperatureC: 55,
      targetTemperatureC: 65,
    });
    expect(copy.tone).toBe('warning');
    expect(copy.statusLine).toBe('Not drawing power (55 °C / 65 °C)');
    // Chip label stays short and carries NO temperature pair (chips stay short,
    // white-space: nowrap); the pair lives in the status line + tooltip only.
    expect(copy.chipLabel).toBe('Not drawing power');
    expect(copy.chipLabel).not.toContain('/');
    // No breaker/wiring assertion — the fault framing was too strong for a case
    // that is almost always the device's own controller pausing.
    expect(copy.detail).not.toContain('breaker');
    expect(copy.detail).toContain('not drawing power');
    // `unresponsive` only fires past the device's own hysteresis band, so the
    // copy must not frame a sustained condition as momentary ("right now") and
    // must name one concrete, non-alarming check rather than a vague "look later".
    expect(copy.detail).not.toContain('right now');
    expect(copy.detail).toContain('check the device still has power');
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

  it('builds a neutral status line for capped_idle with temperatures', () => {
    const copy = formatIdleClassificationCopy({
      classification: 'capped_idle',
      currentTemperatureC: 58,
      targetTemperatureC: 65,
    });
    expect(copy.tone).toBe('neutral');
    expect(copy.statusLine).toBe('Device reached its own setpoint cap (58 °C / 65 °C)');
    // The detail must name the device's OWN setpoint cap as the recourse
    // surface — never PELS' canonical "hard cap" (per
    // `feedback_hard_cap_is_physical.md`).
    expect(copy.detail).toContain('setpoint cap');
    expect(copy.detail.toLowerCase()).not.toContain('hard cap');
  });

  it('capped_idle degrades gracefully when temperatures are missing', () => {
    const copy = formatIdleClassificationCopy({ classification: 'capped_idle' });
    expect(copy.statusLine).toBe('Device reached its own setpoint cap');
    expect(copy.detail).not.toContain('undefined');
    expect(copy.tone).toBe('neutral');
  });
});
