import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EaseeChargingSession } from '../../lib/device/easee/session';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const device = (status: unknown, atMs = Date.now()): HomeyDeviceLike => ({ ...HOMEY_DEVICE_FIELDS,
  id: 'charger', name: 'Charger', driverId: 'homey:app:no.easee:charger',
  capabilities: ['charger_status'],
  capabilitiesObj: { charger_status: { value: status, lastUpdated: atMs } },
});

describe('Easee charging-session observations', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps newer completion evidence when a stale full read arrives', () => {
    const session = new EaseeChargingSession();
    session.observeDevice(device('Charging'), Date.now());
    vi.setSystemTime(Date.now() + 10_000);
    session.observeCapability('charger', 'charger_status', 'Completed');
    session.observeDevice(device('Charging', Date.now() - 5_000), Date.now());
    expect(session.hasCarStopEvidence('charger')).toBe(true);
    session.observeCapability('charger', 'charger_status', 'Invalid status');
    expect(session.hasCarStopEvidence('charger')).toBe(true);
    session.observeCapability('charger', 'charger_status', 'Standby');
    expect(session.hasCarStopEvidence('charger')).toBe(false);
  });

  it('uses status events and suppresses the app duplicate instead of fabricating a reconnect', () => {
    const session = new EaseeChargingSession();
    session.observeDevice(device('Charging'), Date.now());
    expect(session.controlEvents('charger', 'charger_status', 'Completed'))
      .toEqual([{ capabilityId: 'evcharger_charging_state', value: 'plugged_in' }]);
    expect(session.controlEvents('charger', 'evcharger_charging_state', 'plugged_out')).toEqual([]);
    expect(session.controlEvents('charger', 'charger_status', 'Standby'))
      .toEqual([{ capabilityId: 'evcharger_charging_state', value: 'plugged_out' }]);
  });

  it('does not share evidence between transports and forgets removed devices', () => {
    const first = new EaseeChargingSession();
    first.observeDevice(device('Completed'), Date.now());
    const second = new EaseeChargingSession();
    expect(first.hasCarStopEvidence('charger')).toBe(true);
    expect(second.hasCarStopEvidence('charger')).toBe(false);
    first.retainDevices([]);
    expect(first.hasCarStopEvidence('charger')).toBe(false);
  });

  it.each(['capability', 'identity'])('relinquishes status authority when an accepted read removes its %s', removed => {
    const session = new EaseeChargingSession();
    session.observeDevice(device('Completed'), Date.now());
    const next = device('Charging');
    if (removed === 'capability') next.capabilities = [];
    else next.driverId = 'homey:app:other:charger';
    session.observeDevice(next, Date.now());
    expect(session.controls({ id: 'charger', capabilities: [] })).toBe(false);
    expect(session.hasCarStopEvidence('charger')).toBe(false);
  });

  it('ignores retirement from a full read begun before the newer realtime status', () => {
    const session = new EaseeChargingSession();
    session.observeDevice(device('Charging'), Date.now());
    const oldReadAtMs = Date.now();
    vi.setSystemTime(Date.now() + 10_000);
    session.observeCapability('charger', 'charger_status', 'Completed');
    const oldRead = { ...device('Charging'), capabilities: [] };
    session.observeDevice(oldRead, oldReadAtMs);
    expect(session.controls({ id: 'charger', capabilities: [] })).toBe(true);
    expect(session.hasCarStopEvidence('charger')).toBe(true);
  });

  it.each(['capability', 'identity'])('does not reclaim retired %s authority from an older delayed read', removed => {
    const session = new EaseeChargingSession();
    const atMs = Date.now();
    session.observeDevice(device('Completed', atMs + 100), atMs + 100);
    const retired = device('Charging', atMs + 300);
    if (removed === 'capability') retired.capabilities = [];
    else retired.driverId = 'homey:app:other:charger';
    session.observeDevice(retired, atMs + 300);

    // The delayed source is newer than the original status, but its descriptor
    // was fetched before authority was retired by the accepted newer read.
    session.observeDevice(device('Completed', atMs + 200), atMs + 200);
    expect(session.controls({ id: 'charger', capabilities: [] })).toBe(false);
    expect(session.hasCarStopEvidence('charger')).toBe(false);
    session.observeCapability('charger', 'charger_status', 'Completed');
    expect(session.hasCarStopEvidence('charger')).toBe(false);

    session.observeDevice(device('Completed', atMs + 400), atMs + 400);
    expect(session.controls({ id: 'charger', capabilities: [] })).toBe(true);
    expect(session.hasCarStopEvidence('charger')).toBe(true);
  });
});
