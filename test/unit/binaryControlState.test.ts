import { isBinaryOnOrUnknown, isBinaryObservedOff } from '../../packages/shared-domain/src/binaryControlState';

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
});
