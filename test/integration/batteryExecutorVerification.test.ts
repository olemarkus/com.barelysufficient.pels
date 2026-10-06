// Executor-layer cover for the storage lane: claim before the first setpoint,
// no re-send while one is in flight, the verification lifecycle that keeps a
// battery that does not follow (or follows backwards) from earning credit, and
// the hand-back. The verdicts land in the real `BatteryVerificationLedger`.
import { BatteryExecutor, VERIFICATION_MAX_WAIT_MS } from '../../lib/executor/batteryExecutor';
import type { StorageDecidedDevice } from '../../lib/planContract/storageDecision';
import { BatteryVerificationLedger, DELIVERY_CEILING_TTL_MS } from '../../lib/battery/batteryVerification';
import type {
  BatteryControlOwner,
  BatteryHandBackOutcome,
  BatteryLeverRead,
} from '../../lib/ports/batteryControlOwner';
import type { Actuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorOutcome, DeviceCommand } from '../../lib/actuator/deviceCommand';
import type { HomeBatteryPowerObservation, HomeBatterySetpointRange } from '../../packages/contracts/src/types';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { ExecutorDeviceReadDeps, ObserverDeviceRead } from '../../lib/executor/executorDeviceRead';
import type { DeviceConfigurationRead } from '../../lib/ports/deviceConfigurationRead';
import type { StorageDecision } from '../../lib/planContract/storageDecision';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/ports/controlCommandConfirmation';
import { buildPlanDevice } from '../utils/planTestUtils';

const BATTERY = 'battery';
const LOAD = 'heater';
const RANGE: HomeBatterySetpointRange = { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 };
const START_MS = Date.UTC(2026, 9, 5, 12, 0, 0);

const decided = (storageDecision: StorageDecision): StorageDecidedDevice => (
  { ...buildPlanDevice({ id: BATTERY, name: 'Battery' }), storageDecision }
);

const setpoint = (setpointW: number): StorageDecidedDevice => decided({ kind: 'setpoint', setpointW, stepW: 5 });

const buildLane = () => {
  const ledger = new BatteryVerificationLedger();
  const owned = { held: false, takenOver: false, deferred: false, releaseOutcome: 'released' as BatteryHandBackOutcome };
  let lastActionAtMs = Number.NEGATIVE_INFINITY;
  const owner: BatteryControlOwner = {
    admitClaim: vi.fn(() => {
      owned.held = true;
      return { status: 'admitted' as const };
    }),
    dispatchSetpoint: vi.fn(async (_id, write) => {
      const admission = owner.admitClaim(BATTERY);
      if (admission.status === 'refused') return admission;
      return { status: 'dispatched' as const, setpointW: await write() };
    }),
    readControl: vi.fn((): BatteryLeverRead => ({
      kind: 'setpoint',
      range: RANGE,
      stepW: 5,
      claimHeld: owned.held,
      handBackDeferred: owned.deferred,
      claimEngaged: owned.held && !owned.takenOver,
      admissible: true,
      ...ledger.read(BATTERY, RANGE, Date.now()),
    })),
    releaseClaim: vi.fn(async () => {
      if (owned.releaseOutcome === 'released') owned.held = false;
      return owned.releaseOutcome;
    }),
    verification: ledger,
    onSnapshotCommitted: vi.fn(),
    applyControlSettings: vi.fn(),
    isManaged: vi.fn(() => true),
    wasTakenOver: vi.fn(() => false),
    isWatchOnly: vi.fn(() => false),
    readControlCapability: vi.fn(() => 'drivable' as const),
  };
  const apply = vi.fn(async (command: DeviceCommand): Promise<ActuatorOutcome> => (
    command.kind === 'storage_power'
      ? { requested: true, kind: 'storage_power', requestedSetpointW: command.setpointW }
      : { requested: false }
  ));
  const actuator: Actuator = { canTurnOnDevice: () => true, resolveTemperatureTarget: (_id, desired) => desired, apply };
  let power: HomeBatteryPowerObservation = { signedW: 0, observedAtMs: START_MS - 1_000 };
  let managedW = 2000;
  const tracker: PowerTrackerState = { lastPowerW: 4000, lastTimestamp: START_MS };
  const recordRestore = vi.fn();
  // The observer's records: the battery's own power, and one metered managed load.
  const devices: ExecutorDeviceReadDeps = {
    getDeviceConfiguration: () => undefined,
    getDeviceConfigurations: () => [{ id: LOAD, isBatteryOrSolar: false } as DeviceConfigurationRead],
    getObservedState: (deviceId) => (deviceId === BATTERY
      ? { id: deviceId, batteryPower: power }
      : { id: deviceId, measuredPowerKw: managedW / 1000 }) as ObserverDeviceRead,
  };
  const lane = new BatteryExecutor(
    owner,
    actuator,
    devices,
    () => tracker,
    { hasShedOrRestoreSince: (sinceMs: number) => lastActionAtMs >= sinceMs },
    recordRestore,
  );
  const at = (afterMs: number) => vi.setSystemTime(new Date(START_MS + afterMs));
  return {
    lane,
    recordRestore,
    owner,
    owned,
    apply,
    ledger,
    verdict: () => ledger.read(BATTERY, RANGE, Date.now()).verdict,
    send: async (setpointW: number, afterMs: number): Promise<boolean> => {
      at(afterMs);
      return lane.apply(setpoint(setpointW));
    },
    /** A new reading at `afterMs`: the battery's own power, the meter, and the managed devices' draw. */
    read: (signedW: number, meterW: number, afterMs: number, managed = managedW) => {
      at(afterMs);
      power = { signedW, observedAtMs: START_MS + afterMs };
      tracker.lastPowerW = meterW;
      tracker.lastTimestamp = START_MS + afterMs;
      managedW = managed;
      lane.sync(Date.now());
    },
    /** A plan reading with nothing new from the battery. */
    tick: (meterW: number, afterMs: number) => {
      at(afterMs);
      tracker.lastPowerW = meterW;
      tracker.lastTimestamp = START_MS + afterMs;
      lane.sync(Date.now());
    },
    pelsActedAt: (afterMs: number) => { lastActionAtMs = START_MS + afterMs; },
  };
};

describe('battery storage lane', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START_MS));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a battery report received before the write promise resolves', async () => {
    const { lane, apply, send, read, owner } = buildLane();
    let finish!: () => void;
    apply.mockImplementationOnce(async (command) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return command.kind === 'storage_power'
        ? { requested: true, kind: 'storage_power', requestedSetpointW: command.setpointW }
        : { requested: false };
    });
    const pending = send(-1500, 0);
    read(-1500, 2500, 1000);
    finish();
    await pending;
    lane.sync(Date.now());
    expect(owner.readControl(BATTERY)).toMatchObject({ verdict: 'responding' });
  });

  it('judges the watts actually dispatched by the actuator', async () => {
    const { apply, send, read, owner } = buildLane();
    apply.mockResolvedValueOnce({ requested: true, kind: 'storage_power', requestedSetpointW: 0 });
    await send(-500, 0);
    read(0, 4000, CONTROL_COMMAND_CONFIRMATION_MS);
    expect(owner.readControl(BATTERY)).toMatchObject({ verdict: 'unverified' });
  });

  it('gives a replacement setpoint its own window before learning a ceiling', async () => {
    const { send, read, owner } = buildLane();
    await send(-1500, 0);
    read(-800, 3200, 80_000);
    await send(-2500, 85_000);
    read(-1200, 2800, 90_000);
    expect(owner.readControl(BATTERY)).toMatchObject({ deliveryCeilingW: 2500 });
    read(-2100, 1900, 175_000);
    expect(owner.readControl(BATTERY)).toMatchObject({ deliveryCeilingW: 2100 });
  });

  it('bounds an unresponsive battery even when replacement decisions keep arriving', async () => {
    const { send, tick, owner } = buildLane();
    await send(-1500, 0);
    await send(-2000, 120_000);
    await send(-2500, 240_000);
    tick(4000, VERIFICATION_MAX_WAIT_MS);
    expect(owner.readControl(BATTERY)).toMatchObject({ verdict: 'not_responding' });
  });

  it('does not expire a new settling window after earlier replacements made progress', async () => {
    const { send, read, owner } = buildLane();
    await send(-1500, 0);
    read(-800, 3200, 80_000);
    await send(-2000, 85_000);
    read(-1200, 2800, 160_000);
    await send(-2500, 299_000);
    read(-1600, 2400, 301_000);
    expect(owner.readControl(BATTERY)).toMatchObject({ deliveryCeilingW: 2500 });
  });

  it('transfers an absent release to the owner even when the battery cannot be read', async () => {
    const { lane, owner } = buildLane();
    vi.mocked(owner.readControl).mockReturnValue({ kind: 'none' });
    const intent = { deviceId: BATTERY, reason: 'not_admissible' as const };
    expect(lane.hasReleaseDrift(intent)).toBe(true);
    await lane.releaseAbsent(intent);
    expect(owner.releaseClaim).toHaveBeenCalledWith(BATTERY, 'not_admissible');
  });

  it('admits the claim before the first setpoint and has no write due for one already sent', async () => {
    const { lane, owner, apply, send } = buildLane();

    expect(await send(-1500, 0)).toBe(true);
    expect(owner.admitClaim).toHaveBeenCalledBefore(apply);
    expect(apply).toHaveBeenCalledWith({ kind: 'storage_power', deviceId: BATTERY, setpointW: -1500 });

    expect(await send(-1500, 1_000)).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(lane.hasDrift(setpoint(-1500))).toBe(false);
    expect(lane.hasDrift(setpoint(-1800))).toBe(true);
  });

  it('confirms a battery whose own power reaches the setpoint, and its sign on two readings', async () => {
    const { send, read, verdict } = buildLane();
    await send(-1500, 0);

    read(-1450, 2500, 5_000);
    expect(verdict()).toBe('responding');
    read(-1500, 2480, 15_000);
    read(-1500, 2470, 25_000);
    // A battery that agreed with the meter is not sampled again.
    expect(verdict()).toBe('responding');
  });

  it('waits for a slow cloud reporter instead of calling it not responding', async () => {
    const { send, read, tick, verdict } = buildLane();
    await send(-1500, 0);

    tick(4000, CONTROL_COMMAND_CONFIRMATION_MS);
    tick(4000, 2 * 60_000);
    expect(verdict()).toBe('unverified');

    read(-1500, 2500, 2 * 60_000 + 30_000);
    expect(verdict()).toBe('responding');
  });

  it('reports a battery whose reading does not move as not responding, and stops commanding it', async () => {
    const { lane, send, read, apply, verdict, ledger } = buildLane();
    await send(-1500, 0);

    read(0, 4000, CONTROL_COMMAND_CONFIRMATION_MS);

    expect(verdict()).toBe('not_responding');
    expect(await send(-1500, CONTROL_COMMAND_CONFIRMATION_MS + 1_000)).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(lane.hasDrift(setpoint(-1500))).toBe(false);
    expect(ledger.read(BATTERY, RANGE, Date.now() + 15 * 60_000).verdict).toBe('reprobing');
  });

  it('calls a battery that never reports again not responding only after the longest wait', async () => {
    const { send, tick, verdict } = buildLane();
    await send(-1500, 0);

    tick(4000, VERIFICATION_MAX_WAIT_MS - 10_000);
    expect(verdict()).toBe('unverified');
    tick(4000, VERIFICATION_MAX_WAIT_MS);
    expect(verdict()).toBe('not_responding');
  });

  it('judges a refused write like an unanswered setpoint instead of resending it every rebuild', async () => {
    const { send, read, apply, verdict } = buildLane();
    apply.mockRejectedValueOnce(new Error('Homey refused the claim'));

    expect(await send(-1500, 0)).toBe(false);
    expect(await send(-1500, 30_000)).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);

    read(0, 4000, CONTROL_COMMAND_CONFIRMATION_MS);
    expect(verdict()).toBe('not_responding');
  });

  it('gives no verdict on a setpoint too small to tell from a minimum the battery may have', async () => {
    const { send, read, verdict } = buildLane();
    await send(-300, 0);

    read(0, 4000, CONTROL_COMMAND_CONFIRMATION_MS);
    expect(verdict()).toBe('unverified');
  });

  it('learns its plateau on an increase, keeps it through a step down, and re-learns it on a re-probe', async () => {
    const { send, read, ledger } = buildLane();
    const ceiling = () => ledger.read(BATTERY, RANGE, Date.now()).deliveryCeilingW;

    // Asked for 2.5 kW, it delivers 2 kW and no more.
    await send(-2500, 0);
    read(-2000, 2000, CONTROL_COMMAND_CONFIRMATION_MS);
    expect(ceiling()).toBe(2000);

    // A step down that stops short teaches nothing.
    await send(-500, 100_000);
    read(-1200, 2800, 100_000 + CONTROL_COMMAND_CONFIRMATION_MS);
    expect(ceiling()).toBe(2000);
    expect(ledger.read(BATTERY, RANGE, Date.now()).verdict).toBe('responding');

    // Back at the plateau, and long enough later that the lesson has expired.
    const laterMs = 100_000 + DELIVERY_CEILING_TTL_MS;
    await send(-2000, laterMs);
    read(-2000, 2000, laterMs + 10_000);
    expect(ceiling()).toBe(2500);

    // A raise from the plateau that gets no further re-learns it.
    await send(-2500, laterMs + 60_000);
    read(-2000, 2000, laterMs + 60_000 + CONTROL_COMMAND_CONFIRMATION_MS);
    expect(ledger.read(BATTERY, RANGE, Date.now()))
      .toEqual({ verdict: 'responding', deliveryCeilingW: 2000, chargeCeilingW: 2500 });
  });

  it('confirms a charge setpoint and checks its sign the other way round', async () => {
    const { send, read, verdict, ledger } = buildLane();
    await send(1500, 0);

    // Charging is load: the house's net rises with the battery's own power.
    read(1480, 5500, 5_000);
    expect(verdict()).toBe('responding');
    read(1500, 5510, 15_000);
    read(1500, 5520, 25_000);
    expect(verdict()).toBe('responding');
    expect(ledger.read(BATTERY, RANGE, Date.now()).chargeCeilingW).toBe(2500);
  });

  it('learns a charge ceiling from a charge that stops short, and a full battery is no failure', async () => {
    const { lane, send, read, verdict, ledger } = buildLane();
    const chargeCeiling = () => ledger.read(BATTERY, RANGE, Date.now()).chargeCeilingW;

    // A full battery asked to charge does not move: its own limit, not a fault.
    await send(2000, 0);
    read(0, 3000, CONTROL_COMMAND_CONFIRMATION_MS);
    expect(chargeCeiling()).toBe(0);
    expect(verdict()).toBe('unverified');
    expect(lane.hasDrift(setpoint(2000))).toBe(false);

    // Once the lesson expires, one that charges some and stops short teaches
    // that, and shows the battery follows.
    const laterMs = DELIVERY_CEILING_TTL_MS + 60_000;
    await send(2500, laterMs);
    read(1200, 4200, laterMs + CONTROL_COMMAND_CONFIRMATION_MS);
    expect(chargeCeiling()).toBe(1200);
    expect(verdict()).toBe('responding');

    // A charge delivered past it lifts it.
    await send(2000, laterMs + 200_000);
    read(2000, 5000, laterMs + 205_000);
    expect(chargeCeiling()).toBe(2500);
  });

  it('marks a battery sign-inverted from charge steps too', async () => {
    const { send, read, verdict } = buildLane();
    const invertedStep = async (setpointW: number, meterW: number, atMs: number) => {
      await send(setpointW, atMs);
      read(setpointW, meterW, atMs + 10_000);
      read(setpointW, meterW + 10, atMs + 20_000);
    };

    // The battery reports the charge it was asked for; the house draws LESS.
    await invertedStep(1500, 2500, 0);
    await invertedStep(2500, 1500, 60_000);
    expect(verdict()).toBe('responding');
    await invertedStep(1000, 3000, 120_000);
    expect(verdict()).toBe('sign_inverted');
  });

  it('discounts a managed load ramping during the sign check', async () => {
    const { send, read, verdict } = buildLane();
    // Each step, a managed load moves twice as far the other way: the meter
    // alone reads as if the battery's sign were inverted.
    let meterW = 4000;
    let managedW = 2000;
    const rampedStep = async (fromW: number, toW: number, atMs: number) => {
      const managedDeltaW = -2 * (toW - fromW);
      await send(toW, atMs);
      meterW += (toW - fromW) + managedDeltaW;
      managedW += managedDeltaW;
      read(toW, meterW, atMs + 10_000, managedW);
      read(toW, meterW + 10, atMs + 20_000, managedW);
      meterW += 10;
    };

    await rampedStep(0, -1500, 0);
    await rampedStep(-1500, -2500, 60_000);
    await rampedStep(-2500, -1500, 120_000);

    expect(verdict()).toBe('responding');
  });

  it('marks a battery sign-inverted only after three inverted steps, one of them down', async () => {
    const { send, read, verdict } = buildLane();
    const invertedStep = async (setpointW: number, meterW: number, atMs: number) => {
      await send(setpointW, atMs);
      read(setpointW, meterW, atMs + 10_000);
      read(setpointW, meterW + 10, atMs + 20_000);
    };

    // The battery reports the discharge it was asked for; the house draws MORE.
    await invertedStep(-1500, 5500, 0);
    await invertedStep(-2500, 6500, 60_000);
    expect(verdict()).toBe('responding');
    await invertedStep(-1500, 5500, 120_000);
    expect(verdict()).toBe('sign_inverted');
  });

  it('takes no sign evidence from readings near PELS\'s own shed or restore', async () => {
    const { send, read, pelsActedAt, verdict } = buildLane();
    const invertedStep = async (setpointW: number, meterW: number, atMs: number) => {
      pelsActedAt(atMs);
      await send(setpointW, atMs);
      read(setpointW, meterW, atMs + 10_000);
      read(setpointW, meterW + 10, atMs + 20_000);
    };

    await invertedStep(-1500, 5500, 0);
    await invertedStep(-2500, 6500, 60_000);
    await invertedStep(-1500, 5500, 120_000);
    expect(verdict()).toBe('responding');
  });

  it('stops driving a battery another controller took over instead of claiming it back', async () => {
    const { send, read, owned, apply, verdict } = buildLane();
    await send(-1500, 0);
    read(-1500, 2500, 5_000);

    owned.takenOver = true;
    read(-1500, 2500, CONTROL_COMMAND_CONFIRMATION_MS);

    expect(verdict()).toBe('not_responding');
    expect(await send(-1500, CONTROL_COMMAND_CONFIRMATION_MS + 1_000)).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('forgets a battery the owner handed back mid-claim, and never calls it not responding', async () => {
    const { send, read, owned, verdict } = buildLane();
    await send(-1500, 0);

    owned.held = false;
    read(0, 4000, CONTROL_COMMAND_CONFIRMATION_MS);
    read(0, 4000, VERIFICATION_MAX_WAIT_MS);

    expect(verdict()).toBe('unverified');
  });

  it('hands a held battery back, and does nothing while a hand-back is deferred or did not happen', async () => {
    const { lane, owner, owned, send } = buildLane();
    const release = decided({ kind: 'release', reason: 'idle' });
    await send(-1500, 0);

    owned.deferred = true;
    expect(lane.hasDrift(release)).toBe(false);
    expect(await lane.apply(release)).toBe(false);
    expect(owner.releaseClaim).not.toHaveBeenCalled();

    owned.deferred = false;
    owned.releaseOutcome = 'not_released';
    expect(await lane.apply(release)).toBe(false);

    owned.releaseOutcome = 'released';
    expect(lane.hasDrift(release)).toBe(true);
    expect(await lane.apply(release)).toBe(true);
    expect(owner.releaseClaim).toHaveBeenLastCalledWith(BATTERY, 'idle');
    expect(lane.hasDrift(release)).toBe(false);
  });

  it('stamps the restore clocks only for a restore hand-back the owner made', async () => {
    const { lane, owned, send, recordRestore } = buildLane();
    const restored = decided({ kind: 'release', reason: 'restored' });
    await send(-1500, 0);

    owned.releaseOutcome = 'not_released';
    expect(await lane.apply(restored)).toBe(false);
    expect(recordRestore).not.toHaveBeenCalled();

    owned.releaseOutcome = 'released';
    expect(await lane.apply(restored)).toBe(true);
    expect(recordRestore).toHaveBeenCalledTimes(1);
    expect(recordRestore).toHaveBeenCalledWith(BATTERY, expect.any(String), expect.any(Number));

    await send(-1500, 60_000);
    owned.held = true;
    expect(await lane.apply(decided({ kind: 'release', reason: 'idle' }))).toBe(true);
    expect(recordRestore).toHaveBeenCalledTimes(1);
  });
});
