import {
  isBooleanMap,
  isCommunicationModelMap,
  isFiniteNumber,
  isNumberMap,
  isPrioritySettings,
  isStringMap,
} from '../lib/utils/appTypeGuards';

describe('appTypeGuards plain-object handling', () => {
  describe('isStringMap', () => {
    it('accepts a plain object of string entries', () => {
      expect(isStringMap({ a: '1', b: '2' })).toBe(true);
      expect(isStringMap({})).toBe(true);
    });

    it('rejects arrays, class instances, and non-string entries', () => {
      expect(isStringMap(['a', 'b'])).toBe(false);
      expect(isStringMap(new Date())).toBe(false);
      expect(isStringMap({ a: 1 })).toBe(false);
    });
  });

  describe('isBooleanMap', () => {
    it('accepts a plain object of boolean entries', () => {
      expect(isBooleanMap({ a: true, b: false })).toBe(true);
    });

    it('rejects arrays and non-boolean entries', () => {
      expect(isBooleanMap([true, false])).toBe(false);
      expect(isBooleanMap({ a: 'true' })).toBe(false);
    });
  });

  describe('isNumberMap', () => {
    it('accepts finite-number entries', () => {
      expect(isNumberMap({ a: 1.5, b: 2 })).toBe(true);
    });

    it('rejects non-finite numbers and non-numeric entries', () => {
      expect(isNumberMap({ a: Number.NaN })).toBe(false);
      expect(isNumberMap({ a: '1' })).toBe(false);
    });
  });

  describe('isCommunicationModelMap', () => {
    it('accepts a mix of local/cloud entries', () => {
      expect(isCommunicationModelMap({ a: 'local', b: 'cloud' })).toBe(true);
    });

    it('rejects other strings', () => {
      expect(isCommunicationModelMap({ a: 'wifi' })).toBe(false);
    });
  });

  describe('isPrioritySettings', () => {
    it('accepts a nested record of numeric priorities', () => {
      expect(isPrioritySettings({ Home: { dev: 1 }, Away: { dev: 2 } })).toBe(true);
    });

    it('rejects arrays nested inside the value', () => {
      expect(isPrioritySettings({ Home: ['dev'] })).toBe(false);
    });

    it('rejects non-numeric leaf values', () => {
      expect(isPrioritySettings({ Home: { dev: 'high' } })).toBe(false);
    });
  });

  describe('isFiniteNumber', () => {
    it('matches finite numbers only', () => {
      expect(isFiniteNumber(1)).toBe(true);
      expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
      expect(isFiniteNumber('1')).toBe(false);
    });
  });
});
