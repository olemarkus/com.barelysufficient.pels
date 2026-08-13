import { isActivationObservationActiveNow } from '../../lib/plan/admission';

describe('isActivationObservationActiveNow', () => {
  it('is true when the device reports effectively on', () => {
    // `binaryCapabilityId` is load-bearing: `isActivationObservationActiveNow`
    // reads the producer-resolved `currentOn`, which is the on/off truth only for
    // a binary device (`binaryCapabilityId` set).
    expect(isActivationObservationActiveNow({ currentDrawKw: 0,
      currentOn: true,
    })).toBe(true);
  });

  it('is true when measured power is above the activation threshold', () => {
    expect(isActivationObservationActiveNow({
      currentDrawKw: 0.5,
    })).toBe(true);
  });

  it('is false when the device is reported unavailable', () => {
    expect(isActivationObservationActiveNow({
      available: false,
      currentDrawKw: 5,
    })).toBe(false);
  });

  it('is false for a stepped-load observation that resolves to the off step despite binary currentOn=true', () => {
    // Regression: raw currentOn=true must not short-circuit the effective-on check
    // for stepped-load devices whose selected step is the off step. The previous
    // refactor briefly let this case report active without consulting measured power.
    expect(isActivationObservationActiveNow({
      binaryControl: { on: true },
      currentDrawKw: 0,
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1000 },
        ],
      },
      selectedStepId: 'off',
    } as Parameters<typeof isActivationObservationActiveNow>[0])).toBe(false);
  });
});
