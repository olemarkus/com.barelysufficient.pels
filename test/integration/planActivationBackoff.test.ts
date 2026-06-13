import { isActivationObservationActiveNow } from '../../lib/plan/admission';

describe('isActivationObservationActiveNow', () => {
  it('is true when the device reports effectively on', () => {
    // `controlCapabilityId` is load-bearing: `isActivationObservationActiveNow`
    // delegates to `isObservedOn`, whose `hasBinaryCapability` gate keys off it,
    // so the binary `on` evidence is only honoured when it is present. The field
    // is now declared on `ActivationBackoffObservation`, so no cast is needed.
    expect(isActivationObservationActiveNow({
      binaryControl: { on: true },
      controlCapabilityId: 'onoff',
    })).toBe(true);
  });

  it('is true when measured power is above the activation threshold', () => {
    expect(isActivationObservationActiveNow({
      binaryControl: { on: false },
      measuredPowerKw: 0.5,
    })).toBe(true);
  });

  it('is false when the device is reported unavailable', () => {
    expect(isActivationObservationActiveNow({
      available: false,
      binaryControl: { on: true },
      measuredPowerKw: 5,
    })).toBe(false);
  });

  it('is false for a stepped-load observation that resolves to the off step despite binary currentOn=true', () => {
    // Regression: raw currentOn=true must not short-circuit the effective-on check
    // for stepped-load devices whose selected step is the off step. The previous
    // refactor briefly let this case report active without consulting measured power.
    expect(isActivationObservationActiveNow({
      binaryControl: { on: true },
      measuredPowerKw: 0,
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1000 },
        ],
      },
      selectedStepId: 'off',
    } as Parameters<typeof isActivationObservationActiveNow>[0])).toBe(false);
  });
});
