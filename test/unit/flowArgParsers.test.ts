import {
  readFlowDeviceArg,
  readFlowNumberArg,
  readFlowRawArg,
  readFlowStringArg,
} from '../../flowCards/flowArgParsers';

describe('flow argument parsers', () => {
  describe('readFlowStringArg', () => {
    it('returns the trimmed id when the arg is an autocomplete record', () => {
      expect(readFlowStringArg({ mode: { id: '  Home  ', name: 'Home' } }, 'mode')).toBe('Home');
    });

    it('returns the trimmed string when the arg is a plain string', () => {
      expect(readFlowStringArg({ mode: '  Away  ' }, 'mode')).toBe('Away');
    });

    it('returns empty string for missing or non-string values', () => {
      expect(readFlowStringArg(null, 'mode')).toBe('');
      expect(readFlowStringArg({}, 'mode')).toBe('');
      expect(readFlowStringArg({ mode: 42 }, 'mode')).toBe('');
      expect(readFlowStringArg({ mode: { id: 7 } }, 'mode')).toBe('');
      expect(readFlowStringArg('not an object', 'mode')).toBe('');
      expect(readFlowStringArg([1, 2], 'mode')).toBe('');
    });
  });

  describe('readFlowNumberArg', () => {
    it('returns finite numbers as-is', () => {
      expect(readFlowNumberArg({ power: 1500 }, 'power')).toBe(1500);
      expect(readFlowNumberArg({ power: 0 }, 'power')).toBe(0);
      expect(readFlowNumberArg({ power: -10 }, 'power')).toBe(-10);
    });

    it('parses numeric strings', () => {
      expect(readFlowNumberArg({ power: ' 12.5 ' }, 'power')).toBe(12.5);
    });

    it('returns null for non-finite or missing values', () => {
      expect(readFlowNumberArg({ power: Number.NaN }, 'power')).toBeNull();
      expect(readFlowNumberArg({ power: 'abc' }, 'power')).toBeNull();
      expect(readFlowNumberArg({ power: '' }, 'power')).toBeNull();
      expect(readFlowNumberArg({}, 'power')).toBeNull();
      expect(readFlowNumberArg(null, 'power')).toBeNull();
    });
  });

  describe('readFlowDeviceArg', () => {
    it('extracts id from string, autocomplete record, and legacy data shape', () => {
      expect(readFlowDeviceArg({ device: 'dev-1' })).toBe('dev-1');
      expect(readFlowDeviceArg({ device: { id: 'dev-2', name: 'Heater' } })).toBe('dev-2');
      expect(readFlowDeviceArg({ device: { data: { id: 'dev-3' } } })).toBe('dev-3');
    });

    it('returns empty string when the arg is absent or has no id', () => {
      expect(readFlowDeviceArg({})).toBe('');
      expect(readFlowDeviceArg(null)).toBe('');
      expect(readFlowDeviceArg({ device: { name: 'no id' } })).toBe('');
    });

    it('supports a custom key', () => {
      expect(readFlowDeviceArg({ charger: { id: 'ev-1' } }, 'charger')).toBe('ev-1');
    });
  });

  describe('readFlowRawArg', () => {
    it('returns the raw value when present', () => {
      expect(readFlowRawArg({ x: 'raw' }, 'x')).toBe('raw');
      expect(readFlowRawArg({ x: null }, 'x')).toBeNull();
    });

    it('returns undefined when the key is absent or the arg is not an object', () => {
      expect(readFlowRawArg({}, 'x')).toBeUndefined();
      expect(readFlowRawArg(null, 'x')).toBeUndefined();
      expect(readFlowRawArg('not an object', 'x')).toBeUndefined();
      expect(readFlowRawArg([1, 2], 'x')).toBeUndefined();
    });

    it('ignores keys inherited from the prototype chain', () => {
      const prototype = { polluted: 'evil' };
      const args = Object.create(prototype);
      expect(readFlowRawArg(args, 'polluted')).toBeUndefined();
    });
  });
});
