import { describe, expect, it } from 'vitest';
import {
  shouldDropAfterControlState,
  type ManagedFilterDecision,
} from '../../lib/device/transport/managerManagedFilter';

// A home battery is a FORCE-MANAGED observe-only device (no on/off control, so
// `currentOn` is undefined). It must be KEPT in the runtime snapshot but DROPPED from
// the settings-UI device picker, so it renders exactly once in the settings UI (the
// managed list), never twice.
const managedDecision: ManagedFilterDecision = { hasOracle: true, filterActive: true, isManaged: true };

describe('shouldDropAfterControlState — home battery', () => {
  it('KEEPS a battery on the runtime path despite undefined currentOn', () => {
    expect(shouldDropAfterControlState({
      purpose: 'runtime',
      decision: managedDecision,
      currentOn: undefined,
      deviceClassKey: 'battery',
    })).toBe(false);
  });

  it('DROPS a battery from the ui_picker (its "manage" toggle is a no-op)', () => {
    expect(shouldDropAfterControlState({
      purpose: 'ui_picker',
      decision: managedDecision,
      currentOn: undefined,
      deviceClassKey: 'battery',
    })).toBe(true);
  });

  it('still drops a NON-battery with undefined currentOn on the runtime path (unchanged)', () => {
    expect(shouldDropAfterControlState({
      purpose: 'runtime',
      decision: { hasOracle: true, filterActive: true, isManaged: true },
      currentOn: undefined,
      deviceClassKey: 'heater',
    })).toBe(true);
  });
});
