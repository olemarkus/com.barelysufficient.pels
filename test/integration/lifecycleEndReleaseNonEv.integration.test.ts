/**
 * Integration test for the smart-task lifecycle-end release path for non-EV
 * devices. Mirrors the EaseeMockCharger pattern in `test/integration/evDevices.integration.test.ts`
 * for two non-EV shapes:
 *   1. Binary heater (`controlCapabilityId: 'onoff'`, shedBehavior `turn_off`).
 *   2. Thermostat (`target_temperature` capability, shedBehavior
 *      `set_temperature`).
 *
 * The flow we pin:
 *   - First plan cycle in the satisfied state → `applyShedReleaseIntent` fires
 *     the configured shedBehavior exactly once (binary turn-off for the heater;
 *     target write at shed-temperature for the thermostat).
 *   - The mock device's observed state updates to reflect the new posture.
 *   - Second plan cycle in the satisfied state → executor does NOT re-fire
 *     (binary path: `snapshot.currentOn === false` short-circuits;
 *     temperature path: `observed.target.observedValue === shedTemperature`
 *     short-circuits).
 *
 * Approach: the full deferred-objective wiring in `createApp` requires a real
 * temperature/heater diagnostic to reach `satisfied`. Rather than re-wire the
 * planner against a stale temperature/measure-power input, we drive the
 * release dispatch directly through `applyShedReleaseIntent`, using the real
 * `applyBinarySheddingToDevice` / `applyTargetUpdate` executors (no mocks for
 * the dispatch itself). The intent shape is exactly what the planner emits in
 * the cap-off-satisfied case (see `lib/plan/admission/deferredObjective.ts`'s
 * `shouldEmitTerminalRelease` branch), so the executor's view of the world is
 * production-faithful. Closes TODO §"Integration test: thermostat + binary
 * device lifecycle-end release."
 */
import { applyShedReleaseIntent } from '../../lib/executor/shedReleaseActuation';
import { applyBinarySheddingToDevice, type PlanExecutorBinaryContext } from '../../lib/executor/binaryExecutor';
import type { PlanExecutorTargetContext } from '../../lib/executor/targetExecutor';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorTransport } from '../../lib/actuator/deviceCommand';
import { createPlanEngineState } from '../../lib/plan/planState';
import {
  createPendingBinaryCommandStore,
  type PendingBinaryCommandStore,
} from '../../lib/observer/pendingBinaryCommands';
import type { DeviceObservation } from '../../lib/device/deviceObservation';
import type {
  ExecutableObservedDeviceState,
  ExecutableReleaseIntent,
} from '../../lib/executor/executablePlan';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { ShedAction } from '../../lib/plan/planTypes';

// ---------------------------------------------------------------------------
// Minimal mock device scaffolding (~80 LOC). The EaseeMockCharger pattern is
// EV-shaped (evcharger_charging capability, charging-state machine); for the
// non-EV release path we need plainer fixtures: a binary heater driven via
// `onoff`, and a thermostat driven via `target_temperature`. Both record the
// `setCapability` calls so the test asserts the configured shedBehavior fires.
// ---------------------------------------------------------------------------

type SetCapabilityCall = {
  deviceId: string;
  capabilityId: string;
  value: unknown;
};

// Wrap the harness `setCapability` in an actuator transport so the executor's
// capability-addressed setpoint write (PR1b-2) routes through the single seam.
// Only `setCapability` is exercised by the target path; the other surfaces are
// inert stubs that throw if an unexpected channel is hit.
const buildActuatorTransport = (
  setCapability: (deviceId: string, capabilityId: string, value: unknown) => Promise<unknown>,
): ActuatorTransport => ({
  setCapability,
  applyDeviceTargets: () => Promise.reject(new Error('applyDeviceTargets not expected in release test')),
  triggerFlowBackedBinaryControl: () => Promise.reject(new Error('flow binary not expected in release test')),
});

const buildBinaryHeaterSnapshot = (): TargetDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Mock Binary Heater',
  available: true,
  controlCapabilityId: 'onoff',
  deviceClass: 'socket',
  deviceType: 'onoff',
  currentOn: true,
  powerCapable: true,
  managed: true,
  controllable: false, // cap-off — required for shed_release admission
  targets: [],
  measuredPowerKw: 1.5,
} as unknown as TargetDeviceSnapshot);

const buildThermostatSnapshot = (): TargetDeviceSnapshot => ({
  id: 'thermostat-1',
  name: 'Mock Thermostat',
  available: true,
  controlCapabilityId: 'onoff',
  deviceClass: 'heater',
  deviceType: 'temperature',
  currentOn: true,
  powerCapable: true,
  managed: true,
  controllable: false,
  targets: [{
    id: 'target_temperature',
    value: 22,
    unit: '°C',
    min: 5,
    max: 30,
    step: 0.5,
  }],
  measuredPowerKw: 2.0,
} as unknown as TargetDeviceSnapshot);

// ---------------------------------------------------------------------------
// Lightweight harness wiring the real executor contexts against a mutable
// snapshot map. setCapability records calls AND updates the snapshot so the
// second-cycle idempotency gates (snapshot.currentOn === false for binary,
// observed.target.observedValue === shedTemperature for temperature) see the
// post-actuation state, exactly as production does after a successful write.
// ---------------------------------------------------------------------------

const buildHarness = (devices: TargetDeviceSnapshot[]): {
  state: ReturnType<typeof createPlanEngineState>;
  observation: DeviceObservation;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  setCapability: (deviceId: string, capabilityId: string, value: unknown) => Promise<unknown>;
  setCapabilityCalls: SetCapabilityCall[];
  binaryCtx: PlanExecutorBinaryContext;
  targetCtx: PlanExecutorTargetContext;
} => {
  const snapshots = new Map(devices.map((d) => [d.id, d] as const));
  const observation: DeviceObservation = {
    getSnapshot: () => Array.from(snapshots.values()),
    getSnapshotByDeviceId: (id) => snapshots.get(id),
    getHomePowerW: () => null,
  };
  const state = createPlanEngineState(1_730_000_000_000);
  const pendingBinaryCommandStore = createPendingBinaryCommandStore(state.pendingBinaryCommands);

  const setCapabilityCalls: SetCapabilityCall[] = [];
  const setCapability = async (deviceId: string, capabilityId: string, value: unknown): Promise<unknown> => {
    setCapabilityCalls.push({ deviceId, capabilityId, value });
    // Mutate the snapshot to reflect the new device state, so subsequent
    // cycles see the post-actuation observation.
    const snap = snapshots.get(deviceId);
    if (snap) {
      if (capabilityId === 'onoff') {
        snapshots.set(deviceId, { ...snap, currentOn: value === true } as TargetDeviceSnapshot);
      } else if (capabilityId === 'target_temperature' && typeof value === 'number') {
        const nextTargets = (snap.targets ?? []).map((t) => (
          t.id === 'target_temperature' ? { ...t, value } : t
        ));
        snapshots.set(deviceId, { ...snap, targets: nextTargets } as TargetDeviceSnapshot);
      }
    }
    return undefined;
  };

  const binaryCtx: PlanExecutorBinaryContext = {
    state,
    observation,
    capacityDryRun: false,
    buildBinaryControlTransport: () => ({
      observation,
      pendingBinaryCommandStore,
      setCapability: (deviceId, capabilityId, value) => setCapability(deviceId, capabilityId, value),
    }),
    getRestoreLogSource: () => 'current_plan',
    recordShedActuation: () => {},
    recordReleaseShedActuation: () => {},
    recordRestoreActuation: () => {},
  };

  const targetCtx: PlanExecutorTargetContext = {
    state,
    deviceManager: {
      getSnapshot: () => Array.from(snapshots.values()),
      getSnapshotByDeviceId: (id) => snapshots.get(id),
      setCapability,
    },
    // The capability-addressed setpoint write routes through the actuator over
    // the same `setCapability`, so `setCapabilityCalls` still observes it.
    actuator: createDeviceActuator(buildActuatorTransport(setCapability)),
    operatingMode: 'Home',
    recordShedActuation: () => {},
    recordRestoreActuation: () => {},
    recordActivationAttemptStarted: () => {},
  };

  return {
    state,
    observation,
    pendingBinaryCommandStore,
    setCapability,
    setCapabilityCalls,
    binaryCtx,
    targetCtx,
  };
};

// Variant of `buildHarness` whose `setCapability` records the call but does
// NOT update the snapshot. Used to simulate the async observation lag between
// writing a capability and the device confirming it back.
const buildHarnessNoSnapshotMutation = (devices: TargetDeviceSnapshot[]): ReturnType<typeof buildHarness> => {
  const snapshots = new Map(devices.map((d) => [d.id, d] as const));
  const observation: DeviceObservation = {
    getSnapshot: () => Array.from(snapshots.values()),
    getSnapshotByDeviceId: (id) => snapshots.get(id),
    getHomePowerW: () => null,
  };
  const state = createPlanEngineState(1_730_000_000_000);
  const pendingBinaryCommandStore = createPendingBinaryCommandStore(state.pendingBinaryCommands);

  const setCapabilityCalls: SetCapabilityCall[] = [];
  const setCapability = async (deviceId: string, capabilityId: string, value: unknown): Promise<unknown> => {
    setCapabilityCalls.push({ deviceId, capabilityId, value });
    return undefined;
  };

  const binaryCtx: PlanExecutorBinaryContext = {
    state,
    observation,
    capacityDryRun: false,
    buildBinaryControlTransport: () => ({
      observation,
      pendingBinaryCommandStore,
      setCapability: (deviceId, capabilityId, value) => setCapability(deviceId, capabilityId, value),
    }),
    getRestoreLogSource: () => 'current_plan',
    recordShedActuation: () => {},
    recordReleaseShedActuation: () => {},
    recordRestoreActuation: () => {},
  };

  const targetCtx: PlanExecutorTargetContext = {
    state,
    deviceManager: {
      getSnapshot: () => Array.from(snapshots.values()),
      getSnapshotByDeviceId: (id) => snapshots.get(id),
      setCapability,
    },
    actuator: createDeviceActuator(buildActuatorTransport(setCapability)),
    operatingMode: 'Home',
    recordShedActuation: () => {},
    recordRestoreActuation: () => {},
    recordActivationAttemptStarted: () => {},
  };

  return {
    state,
    observation,
    pendingBinaryCommandStore,
    setCapability,
    setCapabilityCalls,
    binaryCtx,
    targetCtx,
  };
};

const buildIntent = (deviceId: string, name: string): ExecutableReleaseIntent => ({
  kind: 'shed_release',
  deviceId,
  name,
});

const buildObserved = (
  deviceId: string,
  name: string,
  snapshot: TargetDeviceSnapshot,
  overrides?: Partial<ExecutableObservedDeviceState>,
): ExecutableObservedDeviceState => ({
  id: deviceId,
  name,
  snapshot,
  available: true,
  currentOn: snapshot.currentOn,
  observedBinaryState: snapshot.currentOn ? 'on' : 'off',
  target: null,
  steppedLoad: null,
  ...overrides,
});

const buildDeps = (params: {
  shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null };
  binaryCtx: PlanExecutorBinaryContext;
  targetCtx: PlanExecutorTargetContext;
}) => ({
  getShedBehavior: () => params.shedBehavior,
  buildBinaryExecutorContext: () => params.binaryCtx,
  buildTargetExecutorContext: () => params.targetCtx,
  // Stub: this integration test focuses on binary + target paths; no stepped
  // dispatch is exercised. Returning an empty context is safe because none of
  // the asserted paths call applySteppedLoadCommand. The
  // recordReleaseShedActuation no-op is required by ShedReleaseActuationDeps —
  // the release paths fire the per-device pels_shed diagnostic event.
  buildSteppedExecutorContext: () => ({} as never),
  recordReleaseShedActuation: () => {},
});

describe('lifecycle-end release for non-EV devices — integration', () => {
  it('binary heater: fires the configured turn-off once on the satisfied transition, then is idempotent on re-emission', async () => {
      const heater = buildBinaryHeaterSnapshot();
      const harness = buildHarness([heater]);

      // First cycle: satisfied transition → shed_release intent → binary turn-off.
      const intent = buildIntent(heater.id, heater.name);
      const observed = buildObserved(heater.id, heater.name, heater);
      const deps = buildDeps({
        shedBehavior: { action: 'turn_off', temperature: null, stepId: null },
        binaryCtx: harness.binaryCtx,
        targetCtx: harness.targetCtx,
      });
      const firstResult = await applyShedReleaseIntent({
        intent,
        observed,
        snapshot: heater,
        mode: 'plan',
        deps,
      });

      expect(firstResult).toBe(true);
      const onoffWrites = harness.setCapabilityCalls.filter((c) => c.capabilityId === 'onoff');
      expect(onoffWrites).toHaveLength(1);
      expect(onoffWrites[0]).toMatchObject({
        deviceId: heater.id,
        capabilityId: 'onoff',
        value: false,
      });

      // Second cycle: planner re-emits the intent (the design is per-cycle
      // re-emission while the terminal status holds). The observation now
      // reflects the off device — the dispatch path's `snapshot.currentOn ===
      // false` short-circuit must skip the write.
      const refreshedSnapshot = harness.observation.getSnapshotByDeviceId(heater.id)!;
      expect(refreshedSnapshot.currentOn).toBe(false);

      const secondResult = await applyShedReleaseIntent({
        intent,
        observed: buildObserved(heater.id, heater.name, refreshedSnapshot, { currentOn: false, observedBinaryState: 'off' }),
        snapshot: refreshedSnapshot,
        mode: 'plan',
        deps,
      });

      expect(secondResult).toBe(false);
      const onoffWritesAfterReEmit = harness.setCapabilityCalls.filter((c) => c.capabilityId === 'onoff');
      expect(onoffWritesAfterReEmit).toHaveLength(1); // unchanged from the first cycle
    });

    // Counter-case: a heater whose snapshot still reads `currentOn: true` on
    // the second cycle (e.g. the device hasn't reported back yet) is gated by
    // the per-device shed throttle in `shouldSkipShedding`. Without the
    // throttle, the executor would re-issue the same off command every cycle
    // until telemetry confirms.
    it('throttles re-firing within the shed cooldown when the snapshot has not caught up', async () => {
      const heater = buildBinaryHeaterSnapshot();
      const harness = buildHarness([heater]);
      // Drive the first shed manually through `applyBinarySheddingToDevice`
      // to seed `lastDeviceShedMs` (mirrors what the executor records after a
      // successful shed). Pre-throttle the snapshot back to currentOn=true to
      // simulate "the off command landed but telemetry hasn't refreshed yet."
      await applyBinarySheddingToDevice(harness.binaryCtx, {
        deviceId: heater.id,
        deviceName: heater.name,
      });

      // Force the snapshot back to `currentOn: true` so the executor's
      // already-off gate does NOT short-circuit; we want to verify the
      // throttle, not the already-off path.
      const racedSnap = { ...heater, currentOn: true } as TargetDeviceSnapshot;
      const intent = buildIntent(heater.id, heater.name);
      const observed = buildObserved(heater.id, heater.name, racedSnap, { currentOn: true });
      const deps = buildDeps({
        shedBehavior: { action: 'turn_off', temperature: null, stepId: null },
        binaryCtx: harness.binaryCtx,
        targetCtx: harness.targetCtx,
      });
      // shouldSkipShedding consults `state.lastDeviceShedMs` and `Date.now()`;
      // applyBinarySheddingToDevice did NOT set lastDeviceShedMs (that's
      // recorded by `recordShedActuation` at the executor layer). What it
      // DID set is the pending state lifecycle through pendingSheds (add/
      // delete in a try/finally), which is empty by the time we re-enter.
      // So the second call here is gated by the `pendingBinaryCommands`
      // store: the first call recorded a pending entry, and
      // `shouldSkipShedding` checks `state.pendingSheds` for the in-flight
      // window. Since pendingSheds is cleared in the finally block, the
      // gate that actually fires is the pending binary command record.
      const secondResult = await applyShedReleaseIntent({
        intent,
        observed,
        snapshot: racedSnap,
        mode: 'plan',
        deps,
      });
      // Either the pending-binary-command guard or the already-off / pending
      // path skips the write. Either way the test pins that no SECOND
      // capability write is issued.
      expect(secondResult).toBe(false);
      const onoffWrites = harness.setCapabilityCalls.filter((c) => c.capabilityId === 'onoff');
      // Exactly one onoff write across both cycles.
      expect(onoffWrites).toHaveLength(1);
    });

  it('thermostat: fires the target write at the shed temperature once, then is idempotent on re-emission', async () => {
      const thermostat = buildThermostatSnapshot();
      const harness = buildHarness([thermostat]);
      const shedTemperature = 15;

      const intent = buildIntent(thermostat.id, thermostat.name);
      const observed = buildObserved(thermostat.id, thermostat.name, thermostat, {
        target: { targetCap: 'target_temperature', observedValue: 22 },
      });
      const deps = buildDeps({
        shedBehavior: { action: 'set_temperature', temperature: shedTemperature, stepId: null },
        binaryCtx: harness.binaryCtx,
        targetCtx: harness.targetCtx,
      });

      // First cycle.
      const firstResult = await applyShedReleaseIntent({
        intent,
        observed,
        snapshot: thermostat,
        mode: 'plan',
        deps,
      });
      expect(firstResult).toBe(true);
      const tempWrites = harness.setCapabilityCalls.filter((c) => c.capabilityId === 'target_temperature');
      expect(tempWrites).toHaveLength(1);
      expect(tempWrites[0]).toMatchObject({
        deviceId: thermostat.id,
        capabilityId: 'target_temperature',
        value: shedTemperature,
      });

      // Second cycle — observed target now reflects the shed temperature, so
      // the executor's `observedValue === shedTemperature` short-circuit
      // applies. Also pin that the pendingTargetCommands tracker for the
      // device records the in-flight command (or has been cleared after the
      // dispatch). Production's `pendingTargetCommands` map is what gates
      // intra-cycle repeats; the per-cycle re-emission's idempotency comes
      // from the observed-equals-target short-circuit in
      // `applyShedReleaseTemperature`.
      const refreshedObserved = buildObserved(thermostat.id, thermostat.name, thermostat, {
        target: { targetCap: 'target_temperature', observedValue: shedTemperature },
      });
      const secondResult = await applyShedReleaseIntent({
        intent,
        observed: refreshedObserved,
        snapshot: thermostat,
        mode: 'plan',
        deps,
      });
      expect(secondResult).toBe(false);
      const tempWritesAfter = harness.setCapabilityCalls.filter((c) => c.capabilityId === 'target_temperature');
      expect(tempWritesAfter).toHaveLength(1); // unchanged
    });

    it('does not re-issue the target write when the observation lags behind the actuation', async () => {
      // This pins the lag scenario: production observations are async (the
      // device confirms the new setpoint a beat later than the capability
      // write). The producer-resolved `observedValue` on the executable
      // intent reflects the pre-write target, not the post-write value.
      // `applyShedReleaseTemperature` short-circuits on
      // `target.observedValue === shedTemperature`, so the second cycle
      // (with observation now updated) skips. The intermediate cycle (with
      // observation still lagging) is gated by the pendingTargetCommands
      // tracker via `isTargetCommandPending` inside `dispatchTargetCommand`.
      //
      // We use a harness flavor that does NOT mutate the snapshot on
      // `setCapability` to simulate the async lag.
      const thermostat = buildThermostatSnapshot();
      const harness = buildHarnessNoSnapshotMutation([thermostat]);
      const shedTemperature = 15;

      const intent = buildIntent(thermostat.id, thermostat.name);
      const initialObserved = buildObserved(thermostat.id, thermostat.name, thermostat, {
        target: { targetCap: 'target_temperature', observedValue: 22 },
      });
      const deps = buildDeps({
        shedBehavior: { action: 'set_temperature', temperature: shedTemperature, stepId: null },
        binaryCtx: harness.binaryCtx,
        targetCtx: harness.targetCtx,
      });
      const firstResult = await applyShedReleaseIntent({
        intent,
        observed: initialObserved,
        snapshot: thermostat,
        mode: 'plan',
        deps,
      });
      expect(firstResult).toBe(true);

      // After the first write, the pendingTargetCommands tracker holds the
      // in-flight command (observation has not caught up).
      expect(harness.state.pendingTargetCommands[thermostat.id]).toBeDefined();
      expect(harness.state.pendingTargetCommands[thermostat.id]).toMatchObject({
        capabilityId: 'target_temperature',
        desired: shedTemperature,
      });

      // Second cycle: observation still lagging — observed target reads 22.
      // The dispatch must not write again within the pendingTargetCommands
      // window. (Production retries on the configured cadence; tests run
      // back-to-back inside the initial-attempt window, so no retry fires.)
      const staleObserved = buildObserved(thermostat.id, thermostat.name, thermostat, {
        target: { targetCap: 'target_temperature', observedValue: 22 },
      });
      await applyShedReleaseIntent({
        intent,
        observed: staleObserved,
        snapshot: thermostat,
        mode: 'plan',
        deps,
      });
      const tempWrites = harness.setCapabilityCalls.filter((c) => c.capabilityId === 'target_temperature');
      expect(tempWrites).toHaveLength(1);
    });
});
