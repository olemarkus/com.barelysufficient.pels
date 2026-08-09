/**
 * Integration repro of the charger re-shed cooldown deadlock
 * (prod 2026-07-26 20:55Z → 2026-07-27 00:44Z, `Elbillader`).
 *
 * Integration tier: the layer under test is the executor pipeline
 * (PlanExecutor → executable-plan projection → steppedLoadExecutor →
 * binary-control dispatch) with its REAL pending-binary-command store and the
 * REAL restore-timing gate (`buildRestoreTiming` / `shouldPlanRestores`); the
 * held plan is supplied per cycle exactly as the plan service re-applies it.
 * Only the outward seams are mocked via the shared helpers: the device
 * boundary (a mock charger whose snapshot comes from the REAL `parseDevice`
 * and whose `setCapability` echoes like the prod charger) and the clock
 * (faked `Date`).
 *
 * THE PROD LOOP REPRODUCED HERE: a stepped EV charger (`evcharger_charging`
 * control, NO `evcharger_charging_state` capability — zero state events in the
 * prod log) is held at `plannedState: 'shed'` by the planner (in prod: a smart
 * task deferring to cheap overnight hours while the daily budget was binding).
 * The plan service re-applies the plan on every ~35 s rebuild — prod showed a
 * `binary_command_succeeded` off-write PER REBUILD, 321 of them in one evening;
 * the stable-actuation bypass (`shouldApplyStablePlanActions`, the "step
 * prepared, still off" fix) makes executor re-runs over an unchanged plan a
 * designed-in behaviour. Each cycle here therefore applies the same held plan,
 * exactly as the prod service did.
 *
 * CORRECT behaviour (asserted, and what the fix restores):
 *   1. Only the FIRST application — observed charging → off — writes
 *      `evcharger_charging=false`. Re-applications over the already-off charger
 *      write nothing: the observed switch (`evCharging`) already matches.
 *   2. The shed cooldown stamps (`lastInstabilityMs`, `lastDeviceShedMs`) keep
 *      the cycle-1 value: a re-assert is not a load change.
 *   3. 60 s after the real shed, the house-wide restore gate opens
 *      (`inCooldown === false`, `shouldPlanRestores` true).
 *
 * ON THE UNFIXED BASE all three fail, and that failure IS the prod P0: chargers
 * use a direction-specific already-matched rule that cannot treat their strict
 * resolved off-state as command-equivalent, every re-write is recorded as
 * a fresh capacity shed (`recordShedActuation`), and the restamped GLOBAL
 * 60 s cooldown blocks `shouldPlanRestores` for every device in the house —
 * all 12 prod devices sat at `cooldown (shedding)` with countdowns resetting
 * 60→34→17→60 for 3.5 hours of a cheap overnight charging window, and the
 * charger itself could never start its own planned bucket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlanExecutor, type PlanExecutorDeps } from '../../lib/executor/planExecutor';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import {
  parseDevice,
  isDevicePowerCapable,
  type DeviceTransportParseDeps,
} from '../../lib/device/transport/managerParseDevice';
import { DeviceMeasuredPowerResolver } from '../../lib/device/measuredPowerResolver';
import { buildRestoreTiming, shouldPlanRestores } from '../../lib/plan/restore/timing';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';
import { withGetSnapshotByDeviceId } from '../utils/deviceObservationMock';
import type { DevicePlan } from '../../lib/plan/planTypes';
import {
  withBinaryDiscriminant,
  withTemperatureDiscriminant,
  withSteppedDiscriminant,
} from '../../lib/plan/planTypes';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import type { CapabilityValue, HomeyDeviceLike, Logger } from '../../lib/utils/types';

const SHED_REASON = fixtureDeviceReason('shed due to daily budget')!;
const DEVICE_ID = 'elbillader-1';
const START_ISO = '2026-07-26T20:55:00.000Z';
const CYCLE_MS = 35_000; // prod rebuild cadence during the incident
const CYCLES = 6;

const createLogger = (): Logger => ({
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  structuredLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}) as unknown as Logger;

// ── REAL parseDevice deps (only the Homey device is a mock) ──────────────────
const buildParseDeps = (logger: Logger): DeviceTransportParseDeps => ({
  logger,
  providers: {
    getNativeEvWiringEnabled: () => true,
    // The prod charger runs the 1-phase EV preset (steps 6 A → 16 A, 230 V).
    getDeviceTargetPowerConfig: () => ({ enabled: true, preset: 'ev_charger_1_phase' as const }),
  },
  powerState: {
    expectedPowerKwOverrides: {},
    lastKnownPowerKw: {},
    lastEstimateDecisionLogByDevice: new Map(),
    lastPeakPowerLogByDevice: new Map(),
  },
  measuredPowerResolver: new DeviceMeasuredPowerResolver({
    logger,
    lastPositiveMeasuredPowerKw: {},
  }),
  getCapabilityObj: (device) => (device.capabilitiesObj ?? {}) as never,
  isPowerCapable: (device, capsStatus, powerEstimate) =>
        isDevicePowerCapable({ device, capsStatus, powerEstimate }),
  resolveLatestLocalWriteMs: () => undefined,
});

// Prod fidelity: `evcharger_charging` + `target_power` + the plug-state axis.
// The original fixture omitted `evcharger_charging_state` on the belief that the
// prod charger had none ("zero state events in the log"); the prod logs actually
// carry 282 `evcharger_charging_state` observations for this device
// (`8996261a-…`), and `target_power` is the amp/step axis, not a substitute for
// the state axis. The plug-state tracks the switch here so the observed on/off
// fold matches what prod saw.
const buildChargerDevice = (params: { charging: boolean; nowIso: string }): HomeyDeviceLike => {
  const capabilitiesObj: Record<string, CapabilityValue<unknown> | undefined> = {
    measure_power: { value: params.charging ? 3_000 : 0, lastUpdated: params.nowIso },
    target_power: {
      value: 3_450, min: 0, max: 7_360, step: 230, setable: true, lastUpdated: params.nowIso,
    },
    evcharger_charging: { value: params.charging, setable: true, lastUpdated: params.nowIso },
    evcharger_charging_state: {
      value: params.charging ? 'plugged_in_charging' : 'plugged_in_paused',
      lastUpdated: params.nowIso,
    },
  };
  return {
    id: DEVICE_ID,
    name: 'Elbillader',
    class: 'evcharger',
    driverId: 'homey:app:no.easee:charger',
    ownerUri: 'homey:app:no.easee',
    capabilities: ['measure_power', 'target_power', 'evcharger_charging', 'evcharger_charging_state'],
    capabilitiesObj,
    available: true,
    ready: true,
  };
};

const parseChargerSnapshot = (
  params: { charging: boolean; nowMs: number },
  logger: Logger,
): TransportDeviceSnapshot => {
  const nowIso = new Date(params.nowMs).toISOString();
  const parsed = parseDevice({
    device: buildChargerDevice({ charging: params.charging, nowIso }),
    now: params.nowMs + 1_000,
    deps: buildParseDeps(logger),
  });
  if (!parsed) throw new Error('parseDevice returned null for the charger mock device');
  return parsed;
};

// The held plan the service re-applies every rebuild: the charger is
// plannedState 'shed' (in prod: the smart-task hold carried while its restore
// was cooldown-blocked), shed behaviour turn_off.
const buildHeldShedPlan = (snapshot: TransportDeviceSnapshot): DevicePlan => ({
  meta: { totalKw: 0.2, softLimitKw: 6.75, headroomKw: 6.55 },
  devices: [withSteppedDiscriminant(withTemperatureDiscriminant(withBinaryDiscriminant({
    currentDrawKw: 0,
    id: DEVICE_ID,
    name: 'Elbillader',
    commandableNow: true,
    deviceClass: 'evcharger',
    binaryControl: snapshot.binaryControl,
    currentState: snapshot.binaryControl?.on === false ? 'off' : 'on',
    plannedState: 'shed' as const,
    shedAction: 'turn_off' as const,
    currentTarget: null,
    controllable: true,
    steppedLoadProfile: snapshot.steppedLoadProfile,
    controlCapabilityId: 'evcharger_charging' as const,
    selectedStepId: snapshot.reportedStepId ?? '15a',
    desiredStepId: 'off',
    reason: SHED_REASON,
  }))) as DevicePlan['devices'][number]],
});

// ── The executor harness (mirrors steppedLoadRestoreBinaryOnSdkBoundary) ─────
const buildExecutor = (getSnapshot: () => TransportDeviceSnapshot, onBinaryWrite: (value: boolean) => void) => {
  const state = createPlanEngineState();
  const setCapability = vi.fn(async (deviceId: string, capabilityId: string, value: unknown) => {
    if (deviceId === DEVICE_ID && capabilityId === 'evcharger_charging' && typeof value === 'boolean') {
      onBinaryWrite(value);
    }
  });
  const deviceManager = withGetSnapshotByDeviceId({
    getSnapshot: vi.fn(() => [getSnapshot()]),
    setCapability,
    requestSteppedLoadStep: vi.fn(async (_params: unknown) => (
      { requested: true, transport: 'native_capability' as const }
    )),
  });

  const deps: PlanExecutorDeps = {
    getHomeDisplayName: () => 'Main home',
    homeId: 'main',
    setCapacityInShortfall: vi.fn(),
    persistLastControlledMs: vi.fn(),
    deviceManager: deviceManager as never,
    getObservedState: (id) => deviceManager.getSnapshotByDeviceId(id),
    actuator: createDeviceActuator({
      setCapability: (deviceId, capabilityId, value) => deviceManager.setCapability(deviceId, capabilityId, value),
      applyDeviceTargets: async () => undefined,
      triggerFlowBackedBinaryControl: async () => undefined,
      requestSteppedLoadStep: (params) => deviceManager.requestSteppedLoadStep(params),
    }),
    getCapacityGuard: () => undefined,
    getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
    getCapacityDryRun: () => false,
    getOperatingMode: () => 'Home',
    getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
    markSteppedLoadDesiredStepIssued: vi.fn(),
    getSteppedLoadCommandSession: () => ({ hasPriorStepCommand: false }),
    logTargetRetryComparison: vi.fn(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
  };
  return {
    executor: new PlanExecutor(deps, state),
    state,
    setCapability,
  };
};

let logCapture: LoggerCapture;
beforeEach(() => {
  logCapture = captureLogger();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(START_ISO));
});
afterEach(() => {
  logCapture.restore();
  vi.useRealTimers();
});

describe('EV charger shed re-assert freezing all restores (executor-loop repro)', () => {
  it('writes off once, keeps the cooldown stamps at cycle 1, and reopens the restore gate after 60s', async () => {
    const logger = createLogger();

    // Live charger state at the SDK boundary; the off-write echoes into it like
    // the prod charger did (`device_capability_event_received` ~2 s after every
    // accepted write), and each later cycle re-parses the refreshed snapshot.
    let charging = true;
    let snapshot = parseChargerSnapshot({ charging, nowMs: Date.now() }, logger);

    const { executor, state, setCapability } = buildExecutor(
      () => snapshot,
      (value) => { charging = value; },
    );

    // Pin the real parsed snapshot fields that drive the bug.
    expect(snapshot.controlModel).toBe('stepped_load');
    expect(snapshot.controlCapabilityId).toBe('evcharger_charging');
    expect(snapshot.binaryControl?.on).toBe(true);
    expect(snapshot.evCharging).toBe(true);

    // Cycle 1: the planner holds the charging charger — the ONE real shed.
    await executor.applyPlanActions(buildHeldShedPlan(snapshot));
    const offWritesAfterCycle1 = setCapability.mock.calls
      .filter((call) => call[1] === 'evcharger_charging' && call[2] === false).length;
    expect(offWritesAfterCycle1).toBe(1);
    const stampAfterRealShed = state.lastInstabilityMs;
    const deviceStampAfterRealShed = state.lastDeviceShedMs[DEVICE_ID];
    expect(stampAfterRealShed).toBe(Date.now());
    expect(deviceStampAfterRealShed).toBe(Date.now());

    // The charger echoed the write: observed switch false, 0 kW, trusted-off
    // binary observation — the exact prod consolidation ("values_match").
    vi.advanceTimersByTime(2_000);
    snapshot = parseChargerSnapshot({ charging, nowMs: Date.now() }, logger);
    expect(snapshot.evCharging).toBe(false);
    expect(snapshot.binaryControl?.on).toBe(false);
    expect(snapshot.binaryControlObservation).toMatchObject({
      valid: true,
      capabilityId: 'evcharger_charging',
      observedValue: false,
    });

    // Cycles 2..N: the service re-applies the held plan every ~35 s (prod:
    // one rebuild ≈ one off-write, 321 in one evening). The pending window
    // (15 s here — the harness charger resolves communicationModel 'local')
    // has expired by each next cycle, exactly as prod's ~2 s echo
    // confirmation cleared it — nothing suppresses the re-dispatch but the
    // observed state itself. (A 'cloud' charger's 75 s window would mask
    // cycle 2 behind `already_pending` on the unfixed base; cycles 3+ still
    // reproduce, so the repro does not depend on the communication model.)
    for (let cycle = 2; cycle <= CYCLES; cycle += 1) {
      vi.advanceTimersByTime(CYCLE_MS);
      snapshot = parseChargerSnapshot({ charging, nowMs: Date.now() }, logger);
      await executor.applyPlanActions(buildHeldShedPlan(snapshot));
    }

    // CORRECT behaviour 1: no re-writes to the already-off charger. On the
    // unfixed base this fails with one off-write per cycle.
    const offWrites = setCapability.mock.calls
      .filter((call) => call[1] === 'evcharger_charging' && call[2] === false);
    expect(offWrites.length).toBe(1);

    // CORRECT behaviour 2: the cooldown stamps still carry the cycle-1 value —
    // a re-assert over an observed-off device is bookkeeping, not a load
    // change. On the unfixed base both advance every cycle.
    expect(state.lastInstabilityMs).toBe(stampAfterRealShed);
    expect(state.lastDeviceShedMs[DEVICE_ID]).toBe(deviceStampAfterRealShed);

    // CORRECT behaviour 3: the house-wide restore gate reopened 60 s after the
    // real shed (we are now minutes past it), so held devices can resume. On
    // the unfixed base `inCooldown` is permanently true — every device in the
    // house reports `cooldown (shedding)` with a countdown that resets instead
    // of expiring, which is exactly the prod freeze.
    const powerTracker = { lastTimestamp: Date.now() } as PowerTrackerState;
    const timing = buildRestoreTiming(state, 6.5, powerTracker);
    expect(timing.inCooldown).toBe(false);
    expect(shouldPlanRestores(6.5, false, timing)).toBe(true);
  });
});
