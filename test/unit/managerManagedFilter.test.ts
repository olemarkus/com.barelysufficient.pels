import { describe, expect, it } from 'vitest';
import { shouldDropEarly } from '../../lib/device/transport/managerManagedFilter';

// The runtime managed filter keeps a home battery whatever its Managed setting:
// a battery PELS still holds must stay readable to be handed back.
describe('shouldDropEarly', () => {
  const unmanaged = { hasOracle: true, filterActive: true, isManaged: false };

  it('drops an ordinary unmanaged device from the runtime snapshot while the filter is active', () => {
    expect(shouldDropEarly('runtime', unmanaged, false)).toBe(true);
  });

  it('keeps a home battery the owner turned Managed off in the runtime snapshot', () => {
    expect(shouldDropEarly('runtime', unmanaged, true)).toBe(false);
  });

  it('keeps every device while the filter is inactive', () => {
    expect(shouldDropEarly('runtime', { ...unmanaged, filterActive: false }, false)).toBe(false);
  });
});
