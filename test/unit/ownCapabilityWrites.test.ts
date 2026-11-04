import { describe, expect, it } from 'vitest';
import { OwnCapabilityWrites } from '../../lib/device/transport/ownCapabilityWrites';

const T0 = Date.parse('2026-11-03T12:00:00.000Z');

describe('OwnCapabilityWrites', () => {
  it('gives every write its own PELS transaction id', () => {
    const writes = new OwnCapabilityWrites();
    const first = writes.begin('heater', 'target_temperature', T0);
    const second = writes.begin('heater', 'target_temperature', T0);

    expect(first.transactionId).toMatch(/^pels-/);
    expect(second.transactionId).not.toBe(first.transactionId);
  });

  it('recognises the echo by its transaction id on the capability the write reached, once', () => {
    const writes = new OwnCapabilityWrites();
    const write = writes.begin('charger', 'charging_button', T0);

    expect(writes.takeEcho('charger', 'charging_button', write.transactionId)).toEqual(write);
    expect(writes.takeEcho('charger', 'charging_button', write.transactionId)).toBeUndefined();
  });

  it('takes no event without PELS\'s transaction id for its echo, whatever its value', () => {
    const writes = new OwnCapabilityWrites();
    const write = writes.begin('heater', 'target_temperature', T0);

    expect(writes.takeEcho('heater', 'target_temperature', undefined)).toBeUndefined();
    expect(writes.takeEcho('heater', 'target_temperature', '899b3a03-9bef-4dce-ad2a-21a67357afa7')).toBeUndefined();
    expect(writes.takeEcho('other', 'target_temperature', write.transactionId)).toBeUndefined();
    expect(writes.takeEcho('heater', 'onoff', write.transactionId)).toBeUndefined();
  });

  it('forgets a write whose echo never came once the wait is over', () => {
    const writes = new OwnCapabilityWrites();
    const stale = writes.begin('heater', 'target_temperature', T0);
    const recent = writes.begin('heater', 'onoff', T0 + 9 * 60_000);

    writes.begin('heater', 'onoff', T0 + 11 * 60_000);

    expect(writes.takeEcho('heater', 'target_temperature', stale.transactionId)).toBeUndefined();
    expect(writes.takeEcho('heater', 'onoff', recent.transactionId)).toEqual(recent);
  });
});
