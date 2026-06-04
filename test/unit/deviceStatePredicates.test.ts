import {
  isGrayStateDevice,
  isOffLikeState,
  isOnLikeState,
  normalizeDeviceState,
} from '../../packages/shared-domain/src/deviceStatePredicates';

describe('device state predicates', () => {
  describe('normalizeDeviceState', () => {
    it('trims and lower-cases', () => {
      expect(normalizeDeviceState('  ON  ')).toBe('on');
    });

    it('treats undefined as empty', () => {
      expect(normalizeDeviceState(undefined)).toBe('');
    });
  });

  describe('isOnLikeState', () => {
    it('treats arbitrary on values as on-like', () => {
      expect(isOnLikeState('on')).toBe(true);
      expect(isOnLikeState('active')).toBe(true);
    });

    it('does not treat off / unknown / not_applicable / disappeared as on-like', () => {
      expect(isOnLikeState('off')).toBe(false);
      expect(isOnLikeState('unknown')).toBe(false);
      expect(isOnLikeState('not_applicable')).toBe(false);
      // Previously planLegacy treated `disappeared` as on-like — this pins the
      // unified semantic.
      expect(isOnLikeState('disappeared')).toBe(false);
    });

    it('returns false for empty / undefined', () => {
      expect(isOnLikeState(undefined)).toBe(false);
      expect(isOnLikeState('')).toBe(false);
    });
  });

  describe('isOffLikeState', () => {
    it('matches off and unknown', () => {
      expect(isOffLikeState('off')).toBe(true);
      expect(isOffLikeState('unknown')).toBe(true);
    });

    it('normalizes case and whitespace', () => {
      // Previously planLegacy did not normalize — this pins the unified
      // semantic.
      expect(isOffLikeState('  OFF  ')).toBe(true);
      expect(isOffLikeState('Unknown')).toBe(true);
    });

    it('rejects on-like values', () => {
      expect(isOffLikeState('on')).toBe(false);
      expect(isOffLikeState('disappeared')).toBe(false);
    });
  });

  describe('isGrayStateDevice', () => {
    it('treats unavailable devices as gray', () => {
      expect(isGrayStateDevice({ available: false })).toBe(true);
    });

    it('treats stale-observation devices as gray', () => {
      expect(isGrayStateDevice({ observationStale: true })).toBe(true);
    });

    it('treats unknown / disappeared current state as gray', () => {
      expect(isGrayStateDevice({ currentState: 'unknown' })).toBe(true);
      expect(isGrayStateDevice({ currentState: 'disappeared' })).toBe(true);
    });

    it('does not treat fresh on devices as gray', () => {
      expect(isGrayStateDevice({ currentState: 'on', available: true })).toBe(false);
    });

    it('returns false for null / undefined', () => {
      expect(isGrayStateDevice(null)).toBe(false);
      expect(isGrayStateDevice(undefined)).toBe(false);
    });
  });
});
