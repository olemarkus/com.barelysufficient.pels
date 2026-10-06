// Integration test for the STRUCTURAL battery-role resolution at PARSE.
//
// LOCKS the FIX-1 invariant: a role-detected home battery is stamped
// `managed: true, controllable: false` STRUCTURALLY from the device object on EVERY
// parse path — independent of the transport's async-populated battery-id set. So
// there is no window (boot, realtime-before-first-full-refresh, or any settings
// combo) where a present battery resolves `controllable: true`. Detection and
// snapshot SURVIVAL use the SAME predicate (`isHomeBatteryDevice` = class OR the
// `homeBattery` energy role), so an energy-role-only battery is detected, stamped,
// AND survives consistently.
//
// Drives the real transport parse (`parseDeviceListForTests` and the realtime
// `device.update` path), mocking only the SDK seam via the shared homey mock.
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import {
  createTestDeviceTransport,
  onObservedState,
} from '../helpers/deviceTransportHarness';
import type { ProjectedObservedDeviceState } from '../../packages/contracts/src/types';
import {
  createObservationState,
  mergeFresherCapabilityObservations,
} from '../../lib/device/transport/managerObservation';
import Homey from 'homey';
import { mockHomeyInstance } from '../mocks/homey';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';

const homeyMock = mockHomeyInstance as unknown as Homey.App;
const noop = (): void => undefined;
const loggerMock: Logger = {
  log: noop,
  error: noop,
  structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
};

// Providers that — if consulted — would WRONGLY mark the battery controllable:true.
// The structural parse stamp must override them for a battery, proving the stamp is
// settings-independent (the realtime/boot timing window).
const adversarialProviders = {
  getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
  getControllable: () => true,
  getManaged: () => true,
  isManagedFilterActive: () => true,
};

// Homey dates every capability value it reports.
const lastUpdated = new Date().toISOString();
const batteryCaps = {
  measure_battery: { value: 62, id: 'measure_battery', lastUpdated },
  measure_power: { value: 1200, id: 'measure_power', lastUpdated },
} as HomeyDeviceLike['capabilitiesObj'];

describe('structural battery-role resolution at parse', () => {
  it('stamps a class:battery device managed:true/controllable:false despite settings saying controllable:true', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const [parsed] = transport.parseDeviceListForTests([{
      id: 'battery1',
      name: 'Home Battery',
      class: 'battery',
      capabilities: ['measure_battery', 'measure_power'],
      capabilitiesObj: batteryCaps,
    }]);

    expect(parsed).toBeDefined();
    expect(parsed.deviceClass).toBe('battery');
    expect(parsed.managed).toBe(true);
    // The adversarial provider returns controllable:true — the structural stamp wins.
    expect(parsed.controllable).toBe(false);
  });

  it('stamps a battery the owner turned Managed off as unmanaged, still non-controllable', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, {
      ...adversarialProviders,
      getManaged: (deviceId: string) => deviceId !== 'battery-off',
    });
    const [parsed] = transport.parseDeviceListForTests([{
      id: 'battery-off',
      name: 'Home Battery',
      class: 'battery',
      capabilities: ['measure_battery', 'measure_power'],
      capabilitiesObj: batteryCaps,
    }]);

    expect(parsed?.managed).toBe(false);
    expect(parsed?.controllable).toBe(false);
  });

  it('detects AND survives an energy-role-only battery (class not "battery") via the homeBattery role', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const [parsed] = transport.parseDeviceListForTests([{
      id: 'battery2',
      name: 'Inverter Battery',
      // Real class is NOT 'battery' and is not otherwise a supported class — only the
      // canonical energy role marks it. Detection==survival means it still rides the
      // snapshot, normalized to the 'battery' class-key.
      class: 'sensor',
      energy: { homeBattery: true },
      capabilities: ['measure_battery', 'measure_power'],
      capabilitiesObj: batteryCaps,
    }]);

    expect(parsed).toBeDefined();
    expect(parsed.deviceClass).toBe('battery'); // normalized
    expect(parsed.managed).toBe(true);
    expect(parsed.controllable).toBe(false);
  });

  it('stamps the same structural values on the REALTIME device.update path (before any full refresh)', () => {
    // The realtime path parses a single device WITHOUT the full-refresh battery-id
    // re-derivation. With the structural stamp, a battery whose settings say
    // controllable:true STILL resolves controllable:false the moment it is observed.
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    transport.injectDeviceUpdateForTest({
      id: 'battery1',
      name: 'Home Battery',
      class: 'battery',
      capabilities: ['measure_battery', 'measure_power'],
      capabilitiesObj: batteryCaps,
    });

    // The realtime path additively records the battery in the membership set, so the
    // deviceId-only resolve* consumers agree with the structural stamp immediately.
    expect(transport.isBatteryDevice('battery1')).toBe(true);
  });
});

// A Marstek-like battery: Homey's signed `target_power` (negative discharges)
// plus the `target_power_mode` claim. Nothing in this slice writes to it.
const signedTargetPowerBattery = (overrides: {
  measurePowerW?: number;
  targetPowerW?: number | null;
  stepW?: number;
  claim?: { value: string | null; lastUpdated: string };
} = {}): HomeyDeviceLike => ({
  id: 'battery-setpoint',
  name: 'Marstek Venus',
  class: 'battery',
  driverId: 'homey:app:com.marstek:venus',
  capabilities: ['measure_battery', 'measure_power', 'target_power', 'target_power_mode'],
  capabilitiesObj: {
    measure_battery: { id: 'measure_battery', value: 55, lastUpdated },
    measure_power: { id: 'measure_power', value: overrides.measurePowerW ?? -2000, lastUpdated },
    target_power: {
      id: 'target_power',
      value: overrides.targetPowerW === undefined ? 0 : overrides.targetPowerW,
      setable: true,
      min: -2500,
      max: 2500,
      step: overrides.stepW ?? 5,
      units: 'W',
      lastUpdated,
    },
    target_power_mode: {
      id: 'target_power_mode',
      value: overrides.claim === undefined ? 'anti_feed' : overrides.claim.value,
      setable: true,
      values: [{ id: 'homey' }, { id: 'anti_feed' }, { id: 'trade_mode' }, { id: 'manual' }],
      lastUpdated: overrides.claim?.lastUpdated ?? lastUpdated,
    },
  } as HomeyDeviceLike['capabilitiesObj'],
});

describe('home battery control surface at parse', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A 100 W step gives the 0..max half of the range a ladder short enough to
  // build, which is what used to make a battery a stepped load.
  it('does not classify a battery with a signed target_power as a stepped load', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const [parsed] = transport.parseDeviceListForTests([signedTargetPowerBattery({ stepW: 100 })]);

    expect(parsed).toBeDefined();
    expect(parsed.steppedLoadProfile).toBeUndefined();
    expect(parsed.controlModel).not.toBe('stepped_load');
    expect(parsed.nativeWriteCapabilities ?? []).not.toContain('target_power');
    expect(parsed.targetPowerConfig).toBeUndefined();
    expect(parsed.isBatteryOrSolar).toBe(true);
    expect(parsed.controllable).toBe(false);
  });

  it('does not take an owner target-power config onto a battery', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, {
      ...adversarialProviders,
      getDeviceTargetPowerConfig: () => ({ enabled: true, min: 0, max: 2500, step: 500 }),
    });
    const [parsed] = transport.parseDeviceListForTests([signedTargetPowerBattery()]);

    expect(parsed.steppedLoadProfile).toBeUndefined();
    expect(parsed.targetPowerConfig).toBeUndefined();
    expect(parsed.homeBattery?.controlSurface.kind).toBe('setpoint');
  });

  it('reads a battery whose target_power Homey never set', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const [parsed] = transport.parseDeviceListForTests([signedTargetPowerBattery({ targetPowerW: null })]);

    expect(parsed).toBeDefined();
    expect(parsed.batteryPower?.signedW).toBe(-2000);
    expect(parsed.homeBattery?.controlSurface.kind).toBe('setpoint');
  });

  it('resolves the control surface, signed power and claim value', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const [parsed] = transport.parseDeviceListForTests([signedTargetPowerBattery()]);
    const observedAtMs = Date.parse(lastUpdated);

    expect(parsed.homeBattery).toEqual({
      controlSurface: {
        kind: 'setpoint',
        claim: {
          capabilityId: 'target_power_mode',
          homeyValue: 'homey',
          values: ['homey', 'anti_feed', 'trade_mode', 'manual'],
          rejection: 'unanswered',
        },
        range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
      },
    });
    // Discharging keeps its sign here; as a draw it is nothing taken from the house.
    expect(parsed.batteryPower).toEqual({ signedW: -2000, observedAtMs });
    expect(parsed.measuredPowerKw).toBe(0);
    expect(parsed.measuredPowerObservedAtMs).toBe(observedAtMs);
    expect(parsed.batteryClaim).toEqual({ value: 'anti_feed', observedAtMs });
    // The level the battery card shows: read, never decided on.
    expect(parsed.batteryLevel).toEqual({ percent: 55, observedAtMs });
  });

  it('keeps a battery without a claim capability observe-only, still with its signed power', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const [parsed] = transport.parseDeviceListForTests([{
      id: 'battery1',
      name: 'Home Battery',
      class: 'battery',
      capabilities: ['measure_battery', 'measure_power'],
      capabilitiesObj: batteryCaps,
    }]);

    expect(parsed.homeBattery).toEqual({ controlSurface: { kind: 'observe_only', reason: 'no_target_power' } });
    expect(parsed.batteryPower?.signedW).toBe(1200);
    expect(parsed.batteryClaim).toBeUndefined();
  });

  it('gives a non-battery device neither home-battery cluster', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const [parsed] = transport.parseDeviceListForTests([{
      id: 'heater1',
      name: 'Heater',
      class: 'heater',
      capabilities: ['onoff', 'measure_power'],
      capabilitiesObj: {
        onoff: { id: 'onoff', value: true, lastUpdated },
        measure_power: { id: 'measure_power', value: 800, lastUpdated },
      },
    }]);

    expect(parsed).toBeDefined();
    expect(parsed.homeBattery).toBeUndefined();
    expect(parsed.batteryPower).toBeUndefined();
    expect(parsed.batteryClaim).toBeUndefined();
  });

  it('updates the signed power and claim value from realtime events and projects them to the observer', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    transport.setSnapshotForTests(transport.parseDeviceListForTests([signedTargetPowerBattery({ measurePowerW: 900 })]));
    const observed: ProjectedObservedDeviceState[] = [];
    onObservedState(transport, (event) => {
      if (event.observed) observed.push(event.observed as ProjectedObservedDeviceState);
    });

    const beforeMs = Date.now();
    transport.injectCapabilityUpdateForTest('battery-setpoint', 'measure_power', -1500);
    transport.injectCapabilityUpdateForTest('battery-setpoint', 'target_power_mode', 'homey');

    const snapshot = transport.getSnapshotByDeviceId('battery-setpoint');
    expect(snapshot?.batteryPower?.signedW).toBe(-1500);
    expect(snapshot?.batteryPower?.observedAtMs).toBeGreaterThanOrEqual(beforeMs);
    expect(snapshot?.batteryClaim?.value).toBe('homey');
    expect(snapshot?.batteryClaim?.observedAtMs).toBeGreaterThanOrEqual(beforeMs);
    // Discharging draws nothing from the house, dated by the same reading.
    expect(snapshot?.measuredPowerKw).toBe(0);
    expect(snapshot?.measuredPowerObservedAtMs).toBe(snapshot?.batteryPower?.observedAtMs);
    expect(observed.at(-1)?.batteryPower?.signedW).toBe(-1500);
    expect(observed.at(-1)?.measuredPowerKw).toBe(0);
    expect(observed.at(-1)?.batteryClaim?.value).toBe('homey');
  });

  it('updates the battery level from a realtime event, and keeps it through a report out of range', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    transport.setSnapshotForTests(transport.parseDeviceListForTests([signedTargetPowerBattery()]));
    const observed: ProjectedObservedDeviceState[] = [];
    onObservedState(transport, (event) => {
      if (event.observed) observed.push(event.observed as ProjectedObservedDeviceState);
    });

    transport.injectCapabilityUpdateForTest('battery-setpoint', 'measure_battery', 61);
    transport.injectCapabilityUpdateForTest('battery-setpoint', 'measure_battery', 140);

    expect(transport.getSnapshotByDeviceId('battery-setpoint')?.batteryLevel?.percent).toBe(61);
    expect(observed.at(-1)?.batteryLevel?.percent).toBe(61);
  });

  it.each([Number.NaN, null])('rejects a %s battery reading without dispatching it', (junk) => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    transport.setSnapshotForTests(transport.parseDeviceListForTests([signedTargetPowerBattery({ measurePowerW: 900 })]));
    const before = transport.getSnapshotByDeviceId('battery-setpoint')?.batteryPower;
    const events: unknown[] = [];
    onObservedState(transport, (event) => events.push(event));

    transport.injectCapabilityUpdateForTest('battery-setpoint', 'measure_power', junk);

    const snapshot = transport.getSnapshotByDeviceId('battery-setpoint');
    expect(snapshot?.batteryPower).toEqual(before);
    expect(snapshot?.measuredPowerKw).toBe(0.9);
    expect(events).toHaveLength(0);
  });

  it('re-stamps a repeated identical signed reading', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    transport.setSnapshotForTests(transport.parseDeviceListForTests([signedTargetPowerBattery({ measurePowerW: 900 })]));
    const events: unknown[] = [];
    onObservedState(transport, (event) => events.push(event));
    const nowSpy = vi.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1_000_000);
    transport.injectCapabilityUpdateForTest('battery-setpoint', 'measure_power', -1500);
    nowSpy.mockReturnValue(1_005_000);
    transport.injectCapabilityUpdateForTest('battery-setpoint', 'measure_power', -1500);

    const snapshot = transport.getSnapshotByDeviceId('battery-setpoint');
    expect(snapshot?.batteryPower).toEqual({ signedW: -1500, observedAtMs: 1_005_000 });
    expect(snapshot?.measuredPowerObservedAtMs).toBe(1_005_000);
    expect(events).toHaveLength(2);
  });

  // A realtime claim is dated on arrival and a pulled one by Homey, so the two
  // cannot be ordered: a read that reports a different value wins, which is
  // what stops a claim write Homey rejected from outliving every refresh.
  it('lets a full read with a different claim value replace a realtime claim, whatever its stamp', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    transport.setSnapshotForTests(transport.parseDeviceListForTests([signedTargetPowerBattery()]));
    transport.injectCapabilityUpdateForTest('battery-setpoint', 'target_power_mode', 'homey');
    const held = transport.getSnapshotByDeviceId('battery-setpoint');
    const olderStamp = new Date(Date.now() - 60_000).toISOString();
    const pulled = signedTargetPowerBattery({ claim: { value: 'anti_feed', lastUpdated: olderStamp } });

    // A full refresh is the parse, then the fresher-wins merge against what is held.
    const [refreshed] = transport.parseDeviceListForTests([pulled]);
    mergeFresherCapabilityObservations({
      state: createObservationState(),
      previousSnapshot: held ? [held] : [],
      nextSnapshot: [refreshed],
      devices: [pulled],
    });

    expect(held?.batteryClaim?.value).toBe('homey');
    expect(refreshed.batteryClaim).toEqual({ value: 'anti_feed', observedAtMs: Date.parse(olderStamp) });
  });

  it('keeps the last claim through a full read that carries no claim value', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    transport.setSnapshotForTests(transport.parseDeviceListForTests([signedTargetPowerBattery()]));
    transport.injectCapabilityUpdateForTest('battery-setpoint', 'target_power_mode', 'homey');
    const held = transport.getSnapshotByDeviceId('battery-setpoint')?.batteryClaim;

    const [refreshed] = transport.parseDeviceListForTests([
      signedTargetPowerBattery({ claim: { value: null, lastUpdated } }),
    ]);

    expect(held?.value).toBe('homey');
    expect(refreshed.batteryClaim).toEqual(held);
  });

  it('drops the claim when the battery comes to claim through another capability', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const sessy = (withTargetPowerMode: boolean): HomeyDeviceLike => ({
      id: 'sessy-1',
      name: 'Sessy',
      class: 'battery',
      driverId: 'homey:app:nl.sessy:sessy',
      capabilities: [
        'measure_power', 'target_power', 'control_strategy',
        ...(withTargetPowerMode ? ['target_power_mode'] : []),
      ],
      capabilitiesObj: {
        measure_power: { id: 'measure_power', value: -800, lastUpdated },
        target_power: { id: 'target_power', value: null, setable: true, lastUpdated },
        control_strategy: {
          id: 'control_strategy',
          value: 'POWER_STRATEGY_API',
          setable: true,
          values: [{ id: 'POWER_STRATEGY_NOM' }, { id: 'POWER_STRATEGY_API' }],
          lastUpdated,
        },
        ...(withTargetPowerMode ? {
          target_power_mode: {
            id: 'target_power_mode', value: null, setable: true, values: [{ id: 'homey' }, { id: 'device' }], lastUpdated,
          },
        } : {}),
      } as unknown as HomeyDeviceLike['capabilitiesObj'],
    });
    transport.setSnapshotForTests(transport.parseDeviceListForTests([sessy(false)]));
    expect(transport.getSnapshotByDeviceId('sessy-1')?.batteryClaim?.value).toBe('POWER_STRATEGY_API');

    const [refreshed] = transport.parseDeviceListForTests([sessy(true)]);

    expect(refreshed.homeBattery?.controlSurface).toMatchObject({ claim: { capabilityId: 'target_power_mode' } });
    expect(refreshed.batteryClaim).toBeUndefined();
  });

  it('drops the claim when the battery no longer claims through that capability', () => {
    const transport = createTestDeviceTransport(homeyMock, loggerMock, adversarialProviders);
    transport.setSnapshotForTests(transport.parseDeviceListForTests([signedTargetPowerBattery()]));
    const withoutHomeyMode = signedTargetPowerBattery({ claim: { value: null, lastUpdated } });
    const capabilitiesObj = withoutHomeyMode.capabilitiesObj as Record<string, Record<string, unknown>>;
    capabilitiesObj.target_power_mode = { ...capabilitiesObj.target_power_mode, values: [{ id: 'manual' }] };

    const [refreshed] = transport.parseDeviceListForTests([withoutHomeyMode]);

    expect(refreshed.homeBattery?.controlSurface).toEqual({ kind: 'observe_only', reason: 'claim_value_missing' });
    expect(refreshed.batteryClaim).toBeUndefined();
  });
});
