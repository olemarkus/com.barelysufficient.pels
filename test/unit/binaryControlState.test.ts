import {
  isBinaryOnOrUnknown,
  isBinaryObservedOff,
  isBinaryControlled,
  getBinaryOn,
  resolveBinaryCommandCurrentOn,
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
// `resolveBinaryCommandCurrentOn` reads only the producer-resolved command
// control; physical EV charging activity is a separate fact.
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

  describe('resolveBinaryCommandCurrentOn', () => {
    it('does not treat physical charging activity as command acceptance', () => {
      expect(resolveBinaryCommandCurrentOn(
        { binaryControl: { on: false }, evCharging: true },
      )).toBe(false);
      expect(resolveBinaryCommandCurrentOn(
        { binaryControl: { on: true }, evCharging: false },
      )).toBe(true);
    });

    it('is off when activity and the raw control are both off', () => {
      expect(resolveBinaryCommandCurrentOn(
        { binaryControl: { on: false }, evCharging: false },
      )).toBe(false);
    });

    it('returns a strict off value when no EV charge-control field is present', () => {
      expect(resolveBinaryCommandCurrentOn(
        { binaryControl: { on: false } },
      )).toBe(false);
    });

    it('reads the strict latched on-state for a narrowed plain binary control', () => {
      expect(resolveBinaryCommandCurrentOn({ binaryControl: { on: true } })).toBe(true);
      expect(resolveBinaryCommandCurrentOn({ binaryControl: { on: false } })).toBe(false);
    });
  });

  describe('isTrustedObservedBinaryOff', () => {
    it('is true only for a matching off-evidence record', () => {
      expect(isTrustedObservedBinaryOff({
        binaryControlObservation: observation(),
      })).toBe(true);
    });

    it('is false without an evidence record (latched fallback is not evidence)', () => {
      expect(isTrustedObservedBinaryOff({
        binaryControl: { on: false },
      })).toBe(false);
    });

    it('trusts normalized evidence without re-reading a transport address', () => {
      expect(isTrustedObservedBinaryOff({
        binaryControlObservation: observation({ capabilityId: 'onoff' }),
      })).toBe(true);
    });

    it('is false when the evidence says on', () => {
      expect(isTrustedObservedBinaryOff({
        binaryControlObservation: observation({ capabilityId: 'onoff', observedValue: true }),
      })).toBe(false);
    });

    it('uses semantic evidence even without a transport capability field', () => {
      expect(isTrustedObservedBinaryOff({ binaryControlObservation: observation() })).toBe(true);
      expect(isTrustedObservedBinaryOff(undefined)).toBe(false);
    });
  });
});
