import { getDeviceAdapter } from '../../lib/device/deviceAdapterRegistry';
import { measuredChargingPhases } from '../../lib/device/chargingPhaseTransport';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const authority = { isCurrent: () => true };
const pauseLifecycle = { onStarting: vi.fn(), onAccepted: vi.fn(), onFailed: vi.fn() };
const stamp = 1_800_000_000_000;
const cap = <T>(value: T, observedAtMs = stamp) => ({ value, lastUpdated: observedAtMs });
const device = (): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS, id: 'charger', name: 'Charger', class: 'evcharger',
  driverId: 'homey:app:com.KyleMichiels.Peblar:peblar_charger',
  capabilities: ['peblar_force_1_phase', 'peblar_charge_limit', 'measure_power',
    'peblar_power_l1', 'peblar_power_l2', 'peblar_power_l3'],
  capabilitiesObj: {
    peblar_force_1_phase: cap(false), peblar_charge_limit: { ...cap(6), min: 6, max: 16, setable: true },
    measure_power: cap(4140), peblar_power_l1: cap(1380), peblar_power_l2: cap(1380), peblar_power_l3: cap(1380),
  },
});

describe('Peblar phase binding', () => {
  it('discovers only the matching integration, and leaves other devices without phase control', () => {
    expect(getDeviceAdapter(device()).phaseBindings(device())).toHaveLength(1);
    const other = { ...device(), driverId: 'homey:app:other:charger' };
    expect(getDeviceAdapter(other).phaseBindings(other)).toEqual([]);
  });

  it('keeps the command setting separate from independently dated physical watts', () => {
    const raw = device();
    raw.capabilitiesObj.peblar_force_1_phase = cap(true, stamp + 1_000);
    const binding = getDeviceAdapter(raw).phaseBindings(raw)[0]!;
    const read = binding.read(raw)!;
    expect(read.forceSinglePhase).toBe(true);
    expect(read.powers).toEqual([0, 1, 2].map(() => ({ watts: 1380, observedAtMs: stamp })));
    expect(measuredChargingPhases(read)).toBe(3);
  });

  it('requires each independent power reading to be finite, nonnegative and dated', () => {
    const raw = device();
    const binding = getDeviceAdapter(raw).phaseBindings(raw)[0]!;
    raw.capabilitiesObj.peblar_power_l2 = cap(Number.NaN);
    expect(binding.read(raw)).toBeUndefined();
    raw.capabilitiesObj.peblar_power_l2 = { value: 0 };
    expect(binding.read(raw)).toBeUndefined();
  });

  it('uses one combined current-and-phase action and a phase-only hand-back', () => {
    const binding = getDeviceAdapter(device()).phaseBindings(device())[0]!;
    expect(binding.command(device(), { kind: 'charging_phase', authority, deviceId: 'charger', phases: 3, currentA: 6 })).toEqual({
      kind: 'app_action', step: {
      deviceId: 'charger', actionId: 'set_charge_limit_with_phase', args: { amps: 6, phase_mode: '3f' },
      },
    });
    expect(binding.command(device(), { kind: 'charging_phase_release', authority, pauseLifecycle,
      deviceId: 'charger', forceSinglePhase: true })).toEqual({
      kind: 'app_action', step: {
      deviceId: 'charger', actionId: 'set_force_1_phase', args: { enabled: true },
      },
    });
  });

  it('uses a 100 W per-phase noise floor and budgets a two-phase car in the three-phase envelope', () => {
    const raw = device();
    const binding = getDeviceAdapter(raw).phaseBindings(raw)[0]!;
    raw.capabilitiesObj.peblar_power_l2 = cap(100);
    raw.capabilitiesObj.peblar_power_l3 = cap(0);
    raw.capabilitiesObj.measure_power = cap(1480);
    expect(measuredChargingPhases(binding.read(raw)!)).toBe(1);
    raw.capabilitiesObj.peblar_power_l2 = cap(101);
    expect(measuredChargingPhases(binding.read(raw)!)).toBe(3);
    raw.capabilitiesObj.peblar_power_l1 = cap(0);
    raw.capabilitiesObj.peblar_power_l2 = cap(0);
    raw.capabilitiesObj.measure_power = cap(0);
    expect(measuredChargingPhases(binding.read(raw)!)).toBeUndefined();
  });

  it('does not accept a partial polling update as a new operating envelope', () => {
    const raw = device();
    const binding = getDeviceAdapter(raw).phaseBindings(raw)[0]!;
    raw.capabilitiesObj.peblar_power_l2 = cap(0);
    raw.capabilitiesObj.peblar_power_l3 = cap(0);
    expect(measuredChargingPhases(binding.read(raw)!)).toBeUndefined();
  });
});
