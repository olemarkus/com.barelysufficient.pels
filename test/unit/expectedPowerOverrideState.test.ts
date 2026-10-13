import { applyExpectedPowerOverrides } from '../../lib/device/expectedPowerOverrideState';
import type { DeviceExpectedPowerOverrides } from '../../packages/contracts/src/types';

describe('applyExpectedPowerOverrides', () => {
  it('notifies only the devices whose figure actually changed', () => {
    // The change-gate is what keeps the settings-key writer and the Flow writer
    // (`setExpectedOverride`) leaving the app in the same state: a re-persist of
    // an unchanged record must not re-seed the headroom card's tracked usage.
    const target: DeviceExpectedPowerOverrides = {
      unchanged: { kw: 1.5, ts: 1 },
      changed: { kw: 1.5, ts: 1 },
    };
    const notified: Array<[string, number]> = [];

    applyExpectedPowerOverrides(
      {
        state: 'resolved',
        overrides: {
          unchanged: { kw: 1.5, ts: 2 },
          changed: { kw: 2.5, ts: 2 },
          added: { kw: 3, ts: 2 },
        },
      },
      target,
      'persisted',
      (deviceId, kw) => notified.push([deviceId, kw]),
    );

    expect(notified).toEqual([['changed', 2.5], ['added', 3]]);
  });

  it('mutates the map in place so the transport keeps reading the same object', () => {
    const target: DeviceExpectedPowerOverrides = { gone: { kw: 1, ts: 1 } };
    const held = target;

    expect(applyExpectedPowerOverrides(
      { state: 'resolved', overrides: { kept: { kw: 2, ts: 2 } } },
      target,
      'persisted',
      () => {},
    )).toBe(true);

    expect(held).toBe(target);
    expect(target).toEqual({ kept: { kw: 2, ts: 2 } });
  });

  it('lets the held figure stand under held authority, filling only the gaps', () => {
    // The write fence's late read: the owner typed `typed` this run and it has
    // not reached settings yet, so the record may add what it knows about other
    // devices but must not undo the newer instruction — nor report one.
    const target: DeviceExpectedPowerOverrides = { typed: { kw: 2.4, ts: 9 } };
    const notified: string[] = [];

    applyExpectedPowerOverrides(
      {
        state: 'resolved',
        overrides: { typed: { kw: 1, ts: 1 }, stored: { kw: 7, ts: 1 } },
      },
      target,
      'held',
      (deviceId) => notified.push(deviceId),
    );

    expect(target).toEqual({ typed: { kw: 2.4, ts: 9 }, stored: { kw: 7, ts: 1 } });
    expect(notified).toEqual(['stored']);
  });

  it('leaves the map untouched and answers false when the read is unavailable', () => {
    // An unreadable key is not an empty record. Answering `false` is what keeps
    // the caller's write fence shut, so nothing overwrites what it cannot read.
    const target: DeviceExpectedPowerOverrides = { heater: { kw: 2.4, ts: 1 } };

    expect(applyExpectedPowerOverrides(
      { state: 'unavailable' },
      target,
      'persisted',
      () => {
        throw new Error('must not notify on an unavailable read');
      },
    )).toBe(false);

    expect(target).toEqual({ heater: { kw: 2.4, ts: 1 } });
  });
});
