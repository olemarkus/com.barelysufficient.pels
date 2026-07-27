import {
  isBinaryOnOrUnknown,
  isBinaryObservedOff,
  isBinaryControlled,
  getBinaryOn,
  getObservedBinaryControlValue,
  isTrustedObservedBinaryOff,
} from '../../packages/shared-domain/src/binaryControlState';

describe('binary observed-state predicates', () => {
  describe('isBinaryOnOrUnknown (≡ binaryControl?.on ?? true)', () => {
    it('is true when observed on', () => {
      expect(isBinaryOnOrUnknown({ binaryControl: { on: true } })).toBe(true);
    });
    it('is false when observed off', () => {
      expect(isBinaryOnOrUnknown({ binaryControl: { on: false } })).toBe(false);
    });
    it('is true (assume-on) when binary state is absent', () => {
      expect(isBinaryOnOrUnknown({})).toBe(true);
    });
    it('is true for a null/undefined device (matches `device?.binaryControl?.on ?? true`)', () => {
      expect(isBinaryOnOrUnknown(undefined)).toBe(true);
      expect(isBinaryOnOrUnknown(null)).toBe(true);
    });
  });

  describe('isBinaryObservedOff (≡ binaryControl?.on === false)', () => {
    it('is true only when observed off', () => {
      expect(isBinaryObservedOff({ binaryControl: { on: false } })).toBe(true);
    });
    it('is false when observed on', () => {
      expect(isBinaryObservedOff({ binaryControl: { on: true } })).toBe(false);
    });
    it('is false (NOT off) when binary state is absent', () => {
      expect(isBinaryObservedOff({})).toBe(false);
      expect(isBinaryObservedOff(undefined)).toBe(false);
      expect(isBinaryObservedOff(null)).toBe(false);
    });
  });

  it('the two predicates are exact complements on any input', () => {
    for (const d of [{ binaryControl: { on: true } }, { binaryControl: { on: false } }, {}, undefined, null]) {
      expect(isBinaryOnOrUnknown(d)).toBe(!isBinaryObservedOff(d));
    }
  });

  describe('isBinaryControlled (type guard; non-binary is the else-branch, not a value)', () => {
    it('is true when the device has binary control', () => {
      expect(isBinaryControlled({ binaryControl: { on: true } })).toBe(true);
      expect(isBinaryControlled({ binaryControl: { on: false } })).toBe(true);
    });
    it('is false when the device has no binary control', () => {
      expect(isBinaryControlled({})).toBe(false);
      expect(isBinaryControlled(undefined)).toBe(false);
      expect(isBinaryControlled(null)).toBe(false);
    });
  });

  describe('getBinaryOn (strict read on a narrowed binary device)', () => {
    it('returns the observed on-state', () => {
      expect(getBinaryOn({ binaryControl: { on: true } })).toBe(true);
      expect(getBinaryOn({ binaryControl: { on: false } })).toBe(false);
    });
    it('reads strict only after narrowing — the match-check pattern', () => {
      // planBinaryControlHelpers: `isBinaryControlled(d) && getBinaryOn(d) === desired`.
      // A non-binary device short-circuits at the guard, never reaching getBinaryOn.
      const nonBinary: { binaryControl?: { on: boolean } } = {};
      const matches = (d: { binaryControl?: { on: boolean } }, desired: boolean): boolean => (
        isBinaryControlled(d) && getBinaryOn(d) === desired
      );
      expect(matches(nonBinary, true)).toBe(false);
      expect(matches(nonBinary, false)).toBe(false);
      expect(matches({ binaryControl: { on: true } }, true)).toBe(true);
      expect(matches({ binaryControl: { on: true } }, false)).toBe(false);
    });
  });
});

// Producer readers behind the charger re-shed fix (prod 2026-07-26):
// `getObservedBinaryControlValue` answers "what does observation say the
// CONTROL capability reads" (a charger's raw switch, everyone else's latched
// on-state); `isTrustedObservedBinaryOff` answers "does trusted evidence say
// the control is off" (evidence record only — never the latched fallback).
describe('observed binary control-value readers', () => {
  const observation = (overrides: Partial<{
    capabilityId: string;
    observedValue: boolean;
    observedCapabilityIds: string[];
  }> = {}) => ({
    valid: true as const,
    capabilityId: 'evcharger_charging',
    observedValue: false,
    observedCapabilityIds: ['evcharger_charging'],
    ...overrides,
  });

  describe('getObservedBinaryControlValue', () => {
    it('reads raw-switch-provenance evidence for a charger, not the activity-derived on-state', () => {
      expect(getObservedBinaryControlValue(
        { binaryControl: { on: false }, binaryControlObservation: observation({ observedValue: true }) },
        'evcharger_charging',
      )).toBe(true);
      expect(getObservedBinaryControlValue(
        { binaryControl: { on: true }, binaryControlObservation: observation({ observedValue: false }) },
        'evcharger_charging',
      )).toBe(false);
    });

    it('resolves undefined for state-derived provenance (paused-but-armed charger)', () => {
      // `plugged_in_paused` produces observedValue false with state provenance
      // while the real switch may still be true — it must never read as an
      // observed-off switch.
      expect(getObservedBinaryControlValue(
        {
          binaryControl: { on: false },
          binaryControlObservation: observation({ observedCapabilityIds: ['evcharger_charging_state'] }),
        },
        'evcharger_charging',
      )).toBeUndefined();
    });

    it('resolves undefined for a charger with no evidence record', () => {
      expect(getObservedBinaryControlValue(
        { binaryControl: { on: false } },
        'evcharger_charging',
      )).toBeUndefined();
    });

    it('reads the latched on-state for a plain binary control', () => {
      expect(getObservedBinaryControlValue({ binaryControl: { on: true } }, 'onoff')).toBe(true);
      expect(getObservedBinaryControlValue({ binaryControl: { on: false } }, 'onoff')).toBe(false);
      expect(getObservedBinaryControlValue({}, 'onoff')).toBeUndefined();
    });

    it('resolves undefined for an absent snapshot', () => {
      expect(getObservedBinaryControlValue(undefined, 'onoff')).toBeUndefined();
    });
  });

  describe('isTrustedObservedBinaryOff', () => {
    it('is true only for a matching off-evidence record', () => {
      expect(isTrustedObservedBinaryOff({
        controlCapabilityId: 'evcharger_charging',
        binaryControlObservation: observation(),
      })).toBe(true);
    });

    it('is false without an evidence record (latched fallback is not evidence)', () => {
      expect(isTrustedObservedBinaryOff({
        controlCapabilityId: 'evcharger_charging',
        binaryControl: { on: false },
      })).toBe(false);
    });

    it('is false when the evidence covers a different control capability', () => {
      expect(isTrustedObservedBinaryOff({
        controlCapabilityId: 'evcharger_charging',
        binaryControlObservation: observation({ capabilityId: 'onoff' }),
      })).toBe(false);
    });

    it('is false when the evidence says on', () => {
      expect(isTrustedObservedBinaryOff({
        controlCapabilityId: 'onoff',
        binaryControlObservation: observation({ capabilityId: 'onoff', observedValue: true }),
      })).toBe(false);
    });

    it('is false without a control capability or snapshot', () => {
      expect(isTrustedObservedBinaryOff({ binaryControlObservation: observation() })).toBe(false);
      expect(isTrustedObservedBinaryOff(undefined)).toBe(false);
    });
  });
});
