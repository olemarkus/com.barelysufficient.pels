import {
  getTargetCapabilityStep,
  normalizeTargetCapabilityValue,
} from './mocks/contracts-targetCapabilities';

describe('contracts target capability shim', () => {
  it('matches the shared helper public step API', () => {
    expect(getTargetCapabilityStep({ step: 5 })).toBe(5);
    expect(getTargetCapabilityStep(undefined)).toBe(0.5);
  });

  it('preserves precision for scientific-notation step values', () => {
    expect(normalizeTargetCapabilityValue({
      target: { min: 1.23e-7, step: 1.23e-7 },
      value: 2.46e-7,
    })).toBeCloseTo(2.46e-7, 12);
  });
});
