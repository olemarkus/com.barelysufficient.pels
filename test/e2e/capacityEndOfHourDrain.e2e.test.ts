// SDK-boundary e2e for the END-OF-HOUR DRAIN with a heterogeneous fleet crossing
// the hour boundary.
//
// THE RULE THIS TEST ENFORCES: nothing internal is mocked. Power enters through the
// real Homey Energy poll (`manager/energy/live` — the SDK seam), drives the real
// capacity guard + planner + executor, and the only things asserted are what PELS
// writes back through the SDK (`api.put` capability commands). The clock is the
// other SDK input (faked `Date`), so the drain's `minutesRemaining` is real.
//
// WHAT IT EXERCISES: `computeDynamicSoftLimit`'s exponential end-of-hour drain
// (lib/plan/planBudget.ts) — the allowed pace decays toward the sustainable rate as
// the hour ends, so an above-sustainable fleet is wound down *gradually and in
// priority order* before the boundary instead of cliff-shed at a fixed 10-minute mark.
//
// FEEDBACK ENERGY MODEL: the `manager/energy/live` stub reports the *sum of each
// device's commanded draw* (off / setback → 0). So when PELS sheds a device the home
// total drops, and shedding self-limits once the total is back under the falling
// ceiling — the only honest way to observe a progressive, self-stopping wind-down.
//
// ISOLATING THE DRAIN FROM THE BUDGET: a fleet far above the sustainable rate would
// be shed by the *burst budget* (remaining kWh / remaining time), not the drain. The
// app starts at :50 of an otherwise-unused hour, so the burst rate stays well above
// the fleet draw throughout — the falling drain ceiling is the binding constraint.
//
// TIME IS STEPPED IN 10 s POLL INCREMENTS: a single large `advanceTimersByTimeAsync`
// jump drops the detached poll→plan→executor chains for the intermediate cycles, so
// the boundary shed never lands. Stepping one poll interval at a time (and flushing
// the detached chain after each) mirrors how the real app reacts to each sample.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';
import { drainUntil } from '../utils/asyncDrain';

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const MIN_MS = 60 * 1000;
const POLL_MS = 10_000;
const ON_TARGET = 21;
const SETBACK_TARGET = 15; // overshoot_behavior set_temperature target
const DRAW_TARGET_THRESHOLD = 18; // commanded target >= this => the thermostat draws
const MEASURE_TEMP = 20; // below ON_TARGET so the thermostat is heating when on
const SUSTAINABLE_KW = 5; // limitKw - margin

type Kind = 'onoff' | 'thermostat';
type DeviceSpec = { id: string; name: string; kind: Kind; watts: number; priority: number };

// Fleet draws 15.5 kW (3.1x sustainable). Priority: higher number => less important
// => shed first (sortCandidates orders by `pb - pa`). Wind-down target: shedding
// ev(5)+dryer(3)+waterheater(3)=11 kW leaves 4.5 kW <= 5 kW sustainable. Survivors
// (highest priority): panel(2)+living(1.5)+bedroom(1) = 4.5 kW.
const FLEET: DeviceSpec[] = [
  { id: 'ev', name: 'EV charger', kind: 'onoff', watts: 5000, priority: 6 },
  { id: 'dryer', name: 'Tumble dryer', kind: 'onoff', watts: 3000, priority: 5 },
  { id: 'waterheater', name: 'Water heater', kind: 'thermostat', watts: 3000, priority: 4 },
  { id: 'panel', name: 'Panel heater', kind: 'onoff', watts: 2000, priority: 3 },
  { id: 'living', name: 'Living room thermostat', kind: 'thermostat', watts: 1500, priority: 2 },
  { id: 'bedroom', name: 'Bedroom socket', kind: 'onoff', watts: 1000, priority: 1 },
];
const SHED_EXPECTED = ['ev', 'dryer', 'waterheater'];
const SURVIVORS_EXPECTED = ['panel', 'living', 'bedroom'];

const buildDevice = async (spec: DeviceSpec): Promise<MockDevice> => {
  if (spec.kind === 'onoff') {
    const device = new MockDevice(spec.id, spec.name, ['onoff', 'measure_power', 'meter_power'], 'socket');
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', spec.watts);
    return device;
  }
  const device = new MockDevice(
    spec.id,
    spec.name,
    ['onoff', 'target_temperature', 'measure_temperature', 'measure_power', 'meter_power', 'thermostat_mode'],
    'heater',
  );
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('target_temperature', ON_TARGET);
  await device.setCapabilityValue('measure_temperature', MEASURE_TEMP);
  await device.setCapabilityValue('measure_power', spec.watts);
  return device;
};

// Feedback energy model: read each device's *commanded* state and sum the draw it
// would pull. An on/off device draws when `onoff === true`; a thermostat draws when
// its commanded target is at or above the heating threshold.
const computeFleetPowerW = async (devices: Map<string, MockDevice>): Promise<number> => {
  let totalW = 0;
  for (const spec of FLEET) {
    const device = devices.get(spec.id)!;
    if (spec.kind === 'onoff') {
      if ((await device.getCapabilityValue('onoff')) === true) totalW += spec.watts;
    } else {
      const target = await device.getCapabilityValue('target_temperature');
      if (typeof target === 'number' && target >= DRAW_TARGET_THRESHOLD) totalW += spec.watts;
    }
  }
  return totalW;
};

// Stub the SDK wire path (`manager/energy/live`) so the real query path runs; the
// reported total is recomputed from live commanded device state on each poll.
const reportHomePower = (totalW: () => Promise<number>) => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: await totalW() } }] };
    }
    return originalGet(path);
  });
};

// Flush the detached poll→plan→executor promise chain (mirrors drainUntil's engine)
// without advancing the wall clock.
const flushDetached = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

describe('End-of-hour drain across the hour boundary (SDK-boundary e2e)', () => {
  let putSpy: ReturnType<typeof vi.spyOn>;

  const isOnoffShed = (id: string, call: unknown[]): boolean =>
    call[0] === cap(id, 'onoff') && (call[1] as { value?: unknown } | undefined)?.value === false;
  const isSetbackShed = (id: string, call: unknown[]): boolean => {
    const value = (call[1] as { value?: unknown } | undefined)?.value;
    return call[0] === cap(id, 'target_temperature') && typeof value === 'number' && value <= SETBACK_TARGET;
  };
  const isShedCall = (spec: DeviceSpec, call: unknown[]): boolean =>
    spec.kind === 'onoff' ? isOnoffShed(spec.id, call) : isSetbackShed(spec.id, call);
  const isRestoreCall = (spec: DeviceSpec, call: unknown[]): boolean => {
    const value = (call[1] as { value?: unknown } | undefined)?.value;
    return spec.kind === 'onoff'
      ? call[0] === cap(spec.id, 'onoff') && value === true
      : call[0] === cap(spec.id, 'target_temperature') && typeof value === 'number' && value > SETBACK_TARGET;
  };
  const specOf = (id: string): DeviceSpec => FLEET.find((s) => s.id === id)!;
  const wasShed = (id: string): boolean =>
    putSpy.mock.calls.some((call: unknown[]) => isShedCall(specOf(id), call));
  const firstShedIndex = (id: string): number =>
    putSpy.mock.calls.findIndex((call: unknown[]) => isShedCall(specOf(id), call));

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('winds a heterogeneous fleet down to the sustainable rate in priority order — not in one cliff', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 12, 0, 0);
    let nowMs = hourStartMs + 50 * MIN_MS; // :50 — 10 minutes left, empty bucket
    vi.setSystemTime(nowMs);

    const devices = new Map<string, MockDevice>();
    for (const spec of FLEET) devices.set(spec.id, await buildDevice(spec));
    setMockDrivers({ driverA: new MockDriver('driverA', Array.from(devices.values())) });

    const flags = Object.fromEntries(FLEET.map((s) => [s.id, true]));
    const priorities = Object.fromEntries(FLEET.map((s) => [s.id, s.priority]));
    const behaviors = Object.fromEntries(FLEET.map((s) => [
      s.id,
      s.kind === 'thermostat'
        ? { action: 'set_temperature', temperature: SETBACK_TARGET }
        : { action: 'turn_off' },
    ]));
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, SUSTAINABLE_KW);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set('controllable_devices', flags);
    mockHomeyInstance.settings.set('managed_devices', flags);
    mockHomeyInstance.settings.set('capacity_priorities', { Home: priorities });
    mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, behaviors);

    reportHomePower(() => computeFleetPowerW(devices));
    putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();

    const stepTo = async (targetMs: number): Promise<void> => {
      while (nowMs < targetMs) {
        const delta = Math.min(POLL_MS, targetMs - nowMs);
        await vi.advanceTimersByTimeAsync(delta);
        nowMs += delta;
        await flushDetached();
      }
    };

    // One poll at :50. Burst (~30 kW, empty bucket) and the drain ceiling (~61 kW) are
    // both far above the 15.5 kW fleet, so nothing is shed — even though the fleet is
    // 3x the sustainable rate. The OLD cliff would have clamped to sustainable here.
    await stepTo(hourStartMs + 50 * MIN_MS + POLL_MS);
    await flushDetached(20);
    expect(FLEET.some((s) => wasShed(s.id))).toBe(false);

    // Wind-down: step toward the boundary one poll at a time. As the drain ceiling
    // falls below the live total, the lowest-priority devices are shed first; each shed
    // drops the reported total so the planner stops once back under the ceiling. The
    // intermediate negative assertions are load-bearing: they prove the wind-down is
    // PROGRESSIVE — a regression that batch-sheds all candidates the moment the drain
    // first binds would fail here, not slip through the final all-shed checks.
    await stepTo(hourStartMs + 56 * MIN_MS);
    await drainUntil(() => wasShed('ev'));
    expect(wasShed('dryer')).toBe(false);
    expect(wasShed('waterheater')).toBe(false);

    await stepTo(hourStartMs + 58 * MIN_MS);
    await drainUntil(() => wasShed('dryer'));
    expect(wasShed('waterheater')).toBe(false);

    await stepTo(hourStartMs + 60 * MIN_MS - POLL_MS); // :59:50, last in-hour poll
    await drainUntil(() => wasShed('waterheater'));

    // The three lowest-priority devices were shed, across both shed actions
    // (turn_off + set_temperature). The three highest-priority devices were not.
    for (const id of SHED_EXPECTED) expect(wasShed(id)).toBe(true);
    for (const id of SURVIVORS_EXPECTED) expect(wasShed(id)).toBe(false);

    // Strictly priority-ordered (lowest priority shed first) — progressive, not a
    // single simultaneous batch.
    expect(firstShedIndex('ev')).toBeLessThan(firstShedIndex('dryer'));
    expect(firstShedIndex('dryer')).toBeLessThan(firstShedIndex('waterheater'));

    // Just before the boundary the fleet is already at / under the sustainable rate.
    // Flush once more so the last shed's capability write has landed before the read.
    await flushDetached();
    expect((await computeFleetPowerW(devices)) / 1000).toBeLessThanOrEqual(SUSTAINABLE_KW + 0.001);

    // Cross the actual boundary: fire the HH:00 poll and roll into the next hourly
    // bucket. Observed purely through the SDK boundary (device capability state + the
    // feedback energy total — no internal planner reads): the surviving load carries
    // under the sustainable rate, and the shed devices stay shed.
    const writeCountBeforeBoundary = putSpy.mock.calls.length;
    await stepTo(hourStartMs + 60 * MIN_MS + POLL_MS); // :00:10 in the next hour
    await flushDetached();
    expect((await computeFleetPowerW(devices)) / 1000).toBeLessThanOrEqual(SUSTAINABLE_KW + 0.001);
    for (const id of SURVIVORS_EXPECTED) expect(wasShed(id)).toBe(false);

    // Keep polling past the 60 s limit cooldown opened by the :59:50 shed. The new
    // hour's ~0.5 kW of available power fits none of the shed devices, so no restore
    // write should land even after the global restore gate can reopen.
    await stepTo(hourStartMs + 61 * MIN_MS + POLL_MS); // :01:10 in the next hour
    await flushDetached();
    expect((await computeFleetPowerW(devices)) / 1000).toBeLessThanOrEqual(SUSTAINABLE_KW + 0.001);

    // Checking the WRITES (not just the end state) catches a restore-then-re-limit
    // flap, which would leave the same shed end state but violate the "nothing is
    // restored" boundary invariant.
    const boundaryWrites = putSpy.mock.calls.slice(writeCountBeforeBoundary);
    for (const id of SHED_EXPECTED) {
      const restored = boundaryWrites.some((call: unknown[]) => isRestoreCall(specOf(id), call));
      expect(restored).toBe(false);
    }

    // And the end state confirms they remain shed.
    for (const id of SHED_EXPECTED) {
      const device = devices.get(id)!;
      if (specOf(id).kind === 'onoff') {
        expect(await device.getCapabilityValue('onoff')).toBe(false);
      } else {
        expect(await device.getCapabilityValue('target_temperature')).toBeLessThanOrEqual(SETBACK_TARGET);
      }
    }
  });

  it('keeps a single above-sustainable device running past the 10-minute mark and sheds it only near the boundary (no cliff)', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 9, 0, 0);
    let nowMs = hourStartMs + 50 * MIN_MS;
    vi.setSystemTime(nowMs);

    // One 8 kW on/off device, sustainable 5 kW. Burst stays high (empty bucket); the
    // drain ceiling crosses 8 kW only at ~1.9 minutes remaining.
    const device = new MockDevice('solo', 'Workshop heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 8000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, SUSTAINABLE_KW);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set('controllable_devices', { solo: true });
    mockHomeyInstance.settings.set('managed_devices', { solo: true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { solo: 1 } });
    mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, { solo: { action: 'turn_off' } });

    reportHomePower(async () => ((await device.getCapabilityValue('onoff')) === true ? 8000 : 0));
    putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();

    const stepTo = async (targetMs: number): Promise<void> => {
      while (nowMs < targetMs) {
        const delta = Math.min(POLL_MS, targetMs - nowMs);
        await vi.advanceTimersByTimeAsync(delta);
        nowMs += delta;
        await flushDetached();
      }
    };
    const soloShed = (): boolean => putSpy.mock.calls.some((call: unknown[]) => isOnoffShed('solo', call));

    // :55 — 5 minutes left, ceiling ~3.5x sustainable: still running (a cliff at the
    // 10-minute mark would already have shed it). Nothing has been written at all.
    await stepTo(hourStartMs + 55 * MIN_MS);
    await flushDetached(20);
    expect(soloShed()).toBe(false);

    // :57:50 — still ~20 s before the ceiling crosses 8 kW (ceiling ~8.6 kW here).
    // Asserting "still not shed" this close to the crossing catches an overly
    // aggressive drain (or any regression that starts limiting earlier in the hour),
    // which a bare jump to the boundary would let pass.
    await stepTo(hourStartMs + 57 * MIN_MS + 50 * 1000);
    await flushDetached(20);
    expect(soloShed()).toBe(false);

    // Step to the boundary: the drain ceiling drops below 8 kW at ~1.9 minutes
    // remaining and the device is shed.
    await stepTo(hourStartMs + 60 * MIN_MS - POLL_MS);
    await drainUntil(() => soloShed());
    expect(soloShed()).toBe(true);
  });

  it('replans from a held Flow sample during short silence as the end-of-hour drain falls', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 10, 0, 0);
    let nowMs = hourStartMs + 57 * MIN_MS + 50 * 1000;
    vi.setSystemTime(nowMs);

    const device = new MockDevice('solo', 'Workshop heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 8000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    mockHomeyInstance.settings.set('power_source', 'flow');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, SUSTAINABLE_KW);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set('controllable_devices', { solo: true });
    mockHomeyInstance.settings.set('managed_devices', { solo: true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { solo: 1 } });
    mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, { solo: { action: 'turn_off' } });

    const getSpy = vi.spyOn(mockHomeyInstance.api, 'get');
    putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();

    const stepTo = async (targetMs: number): Promise<void> => {
      while (nowMs < targetMs) {
        const delta = Math.min(POLL_MS, targetMs - nowMs);
        await vi.advanceTimersByTimeAsync(delta);
        nowMs += delta;
        await flushDetached();
      }
    };
    const flushFlowScheduler = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(1);
      nowMs += 1;
      await flushDetached(20);
    };
    const soloShed = (): boolean => putSpy.mock.calls.some((call: unknown[]) => isOnoffShed('solo', call));
    const reportPowerUsage = mockHomeyInstance.flow._actionCardListeners.report_power_usage;

    await reportPowerUsage({ power: 8000 });
    await flushDetached(20);
    expect(soloShed()).toBe(false);

    await stepTo(hourStartMs + 58 * MIN_MS);
    await flushFlowScheduler();
    expect(soloShed()).toBe(false);

    await stepTo(hourStartMs + 58 * MIN_MS + POLL_MS);
    await flushFlowScheduler();
    await drainUntil(() => soloShed());
    expect(soloShed()).toBe(true);
    expect(getSpy.mock.calls.some((call: unknown[]) => call[0] === 'manager/energy/live')).toBe(false);
  });
});
