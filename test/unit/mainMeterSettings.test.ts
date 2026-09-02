import { describe, expect, it, vi } from 'vitest';
import {
  readMainMeterSelection,
} from '../../setup/mainMeterSettings';

describe('Main meter settings boundary', () => {
  it('normalizes an explicit id', () => {
    expect(readMainMeterSelection({
      get: () => '  meter-main  ',
    })).toEqual({ state: 'resolved', meterDeviceId: 'meter-main' });
  });

  it('classifies every non-string read as unavailable — absence is never a value', () => {
    // Stored null (the retired Automatic), a never-written key, and a
    // transient miss are indistinguishable and all honestly unavailable; a
    // configured install reads a string here because the save seam writes
    // nothing else.
    expect(readMainMeterSelection({ get: () => null }).state).toBe('unavailable');
    expect(readMainMeterSelection({ get: () => undefined }).state).toBe('unavailable');
    expect(readMainMeterSelection({ get: () => 42 }).state).toBe('unavailable');
  });

  it('classifies malformed stored strings as unavailable', () => {
    expect(readMainMeterSelection({ get: () => 'automatic' }).state).toBe('unavailable');
    expect(readMainMeterSelection({ get: () => 'meter-main|areas:active' }).state).toBe('unavailable');
    expect(readMainMeterSelection({ get: () => '   ' }).state).toBe('unavailable');
  });

  it('contains read failures as semantic unavailable authority', () => {
    const settings = {
      get: vi.fn(() => {
        throw new Error('settings unavailable');
      }),
    };
    expect(readMainMeterSelection(settings)).toEqual({ state: 'unavailable' });
  });
});
