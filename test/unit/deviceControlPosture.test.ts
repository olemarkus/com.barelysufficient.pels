import { describe, expect, it } from 'vitest';
import { resolveDeviceControlPosture } from '../../lib/device/temperatureControlPosture';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';
import { partialDouble } from '../helpers/partialDouble';

/**
 * The producer's two INDEPENDENT observe-only vetoes.
 *
 * `commandAuthority` takes `isCapacityControlEnabled` — which leads with the
 * transport's id-set role membership — as a passed argument rather than
 * rebuilding it from `managed` and the owner's Power-limit toggle. A draft of
 * the posture refactor
 * did rebuild it, and that quietly turned the id-set veto into a term that could
 * SUPPLY `managed: true`: `resolveManagedState` returns `true` for exactly the
 * devices the id set calls observe-only. A battery the id set still holds but
 * whose current parse yields an ordinary class key would then have been granted
 * authority off a stale `controllable_devices` entry, and reached the actuator.
 *
 * The two vetoes are meant to disagree without either failing open, so both
 * directions are pinned here.
 */
const snapshot = (fields: Partial<DecoratedDeviceSnapshot>): DecoratedDeviceSnapshot => (
  partialDouble<DecoratedDeviceSnapshot>({
    id: 'dev-1',
    name: 'Device',
    binaryControl: { on: true },
    ...fields,
  })
);

describe('resolveDeviceControlPosture', () => {
  it('grants authority to an ordinary device the owner manages and power-limits', () => {
    const posture = resolveDeviceControlPosture(snapshot({ deviceClass: 'socket' }), true, true);
    expect(posture).toEqual({ managed: true, commandAuthority: true });
  });

  it('refuses authority on the STRUCTURAL class key, whatever the settings say', () => {
    // The id set disagrees with the parse: `isCapacityControlEnabled` says yes.
    const posture = resolveDeviceControlPosture(snapshot({ deviceClass: 'battery' }), true, true);
    expect(posture.commandAuthority).toBe(false);
    // Still managed, because the managed filter must keep observing it.
    expect(posture.managed).toBe(true);
  });

  it('refuses authority on the ID-SET veto, whatever the class key says', () => {
    // The parse disagrees with the id set: an ordinary class key, and the owner
    // has both settings on — but `isCapacityControlEnabled` said no, and that is
    // the only thing that can carry the id set's answer down here.
    const posture = resolveDeviceControlPosture(snapshot({ deviceClass: 'socket' }), true, false);
    expect(posture.commandAuthority).toBe(false);
    expect(posture.managed).toBe(true);
  });

  it('refuses authority when the device has no axis left to command', () => {
    // Temperature control switched off, no binary handle, not stepped.
    const posture = resolveDeviceControlPosture(
      partialDouble<DecoratedDeviceSnapshot>({
        id: 'dev-1', name: 'Thermostat', deviceClass: 'thermostat', temperatureControlDisabled: true,
      }),
      true, true,
    );
    expect(posture.commandAuthority).toBe(false);
  });
});
