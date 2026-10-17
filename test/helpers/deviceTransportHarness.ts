/**
 * Construct a `DeviceTransport` the way production does — with an
 * observer-owned `ObservedStateEmitter` injected — and subscribe to it through
 * that emitter.
 *
 * Why this exists. Transport used to extend `EventEmitter` and fall back to
 * `this.emit(...)` when no `observedStateDispatcher` was injected. Production
 * always injects one (`setup/appInit/wireDeviceTransport.ts`), so that fallback
 * had ZERO production subscribers: every subscription was a spec. It was a
 * second, untyped event surface shadowing the emitter the observer/transport
 * split made canonical — a reader could not tell from `DeviceTransport` alone
 * which one carried the events.
 *
 * Deleting it meant making the dispatcher non-optional, which meant making
 * `options` non-optional, which put every `new DeviceTransport(` site in the
 * blast radius. This file absorbs that: a spec calls
 * `createTestDeviceTransport(...)` with the same positional arguments it used
 * before, and subscribes with `onObservedControlState(transport, fn)` instead of
 * `transport.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, fn)`. Same event,
 * same payload, delivered by the emitter.
 *
 * The transport→emitter association is held in a `WeakMap` rather than returned,
 * so a subscribing spec needs no different construction from a non-subscribing
 * one — and so migrating one is a local edit at the subscription, not a rewrite
 * of the test's setup.
 */
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { createRetainedPowerStore } from '../../lib/device/retainedPowerStore';
import { vi } from 'vitest';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import { ObservedHomePower } from '../../lib/observer/observedHomePower';
import { DEVICES_API_PATH, setRestClient } from '../../lib/device/transport/managerHomeyApi';
import type { SnapshotRefreshOptions } from '../../lib/device/transport/transportTypes';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type {
  DeviceParseSettings,
  DeviceParseSources,
  FlowBackedRead,
  NativeWiringRead,
} from '../../lib/device/transport/managerParseDevice';
import type { DeviceTransportMeters } from '../../lib/device/transport/transportTypes';
import { DeviceManagement } from '../../lib/device/deviceRoleReads';
import type { BatteryManagedRead } from '../../lib/ports/batteryControlOwner';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { mockHomeyInstance } from '../mocks/homey';
import { connectLiveFeed, settleLiveFeed } from './liveFeedSocketHarness';
import type {
  ObservedControlStateChangedEvent,
  ObservedStateChangedEvent,
  ObservedStateEmitterDispatcher,
  ObservedStateRefreshEvent,
} from '../../lib/ports/observedStateEvents';

type TransportArgs = ConstructorParameters<typeof DeviceTransport>;

const emitterByTransport = new WeakMap<DeviceTransport, ObservedStateEmitter>();

/**
 * What a spec states about the owners the transport reads: any subset of each.
 * Production hands the transport the owners themselves (`wireDeviceTransport`);
 * the `test*` builders below complete the rest the way such a spec has always
 * read.
 */
export type TestTransportInputs = {
  settings?: Partial<DeviceParseSettings>;
  nativeWiring?: Partial<NativeWiringRead>;
  flowBacked?: Partial<FlowBackedRead>;
  batteryManaged?: Partial<BatteryManagedRead>;
  meters?: Partial<DeviceTransportMeters>;
};

/** Every device managed and controllable, the filter on, and no per-device configuration. */
export const testParseSettings = (settings: Partial<DeviceParseSettings> = {}): DeviceParseSettings => ({
  isManaged: () => true,
  isControllable: () => true,
  isManagedFilterActive: () => true,
  isBudgetExempt: () => false,
  getDeviceDriverIdOverride: () => undefined,
  getDeviceControlProfile: () => undefined,
  getDeviceTargetPowerConfig: () => undefined,
  getEvCarAssociationCarIds: () => [],
  ...settings,
});

/** No Main meter selected, and no sub-home meters. */
export const testTransportMeters = (meters: Partial<DeviceTransportMeters> = {}): DeviceTransportMeters => ({
  getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
  getAdditionalMeterDeviceIds: () => [],
  onAdditionalMeterReadings: () => undefined,
  ...meters,
});

/** Native wiring off, no Flow conflict or reports, peaks persisted nowhere, every battery managed. */
const testTransportOwners = (inputs: TestTransportInputs) => ({
  settings: testParseSettings(inputs.settings),
  nativeWiring: {
    resolveNativeWiringEnabled: () => false,
    getFlowConflict: () => undefined,
    ...inputs.nativeWiring,
  },
  flowBacked: {
    getFlowReportedCapabilitiesForDevice: () => ({}),
    persistLearnedPeaks: () => undefined,
    ...inputs.flowBacked,
  },
  batteryManaged: { isManaged: () => true, ...inputs.batteryManaged },
});

/**
 * The owners a hand-built parse reads (`DeviceParseSources`), completed as
 * above, with no device detected as a battery or solar device.
 */
export const testParseSources = (inputs: TestTransportInputs = {}): DeviceParseSources => {
  const { settings, nativeWiring, flowBacked, batteryManaged } = testTransportOwners(inputs);
  return {
    settings,
    nativeWiring,
    flowBacked,
    management: new DeviceManagement(
      { isBatteryDevice: () => false, isSolarDevice: () => false },
      batteryManaged,
      settings,
    ),
  };
};

/** A spec's power state completed: empty maps. */
const testPowerState = (powerState: Partial<TransportArgs[2]> = {}): TransportArgs[2] => ({
  expectedPowerKwOverrides: {},
  lastKnownPowerKw: {},
  ...powerState,
});

/**
 * A fully-populated dispatcher of spies, for the specs that assert on the
 * dispatcher itself rather than on delivered events. Every member is present,
 * so adding one to `ObservedStateEmitterDispatcher` is a one-line edit here
 * instead of an edit in each spec that stubs it.
 */
export const createTestObservedStateDispatcher = (
  overrides: Partial<ObservedStateEmitterDispatcher> = {},
): ObservedStateEmitterDispatcher => ({
  observedStateChanged: vi.fn(),
  observedStateRefresh: vi.fn(),
  observedControlStateChanged: vi.fn(),
  externalTemperatureAdjusted: vi.fn(),
  setGenerationW: vi.fn(),
  ...overrides,
});

/**
 * Same positional arguments as the constructor, so a migrating spec keeps its
 * providers/powerState/options exactly as they were. An `observedStateDispatcher`
 * the caller passes wins — a spec asserting on the dispatcher itself keeps doing
 * that, it just cannot then use the subscribe helpers below.
 *
 * That exclusion is enforced, not merely documented: when the caller injects a
 * dispatcher the transport dispatches nowhere near our emitter, so registering
 * it would let `onObservedState(transport, fn)` subscribe to an emitter nothing
 * reaches — a spec that asserts nothing and passes. Leaving it unregistered
 * turns that into the error from `emitterFor`.
 */
export function createTestDeviceTransport(
  homey: TransportArgs[0],
  logger: TransportArgs[1],
  inputs: TestTransportInputs = {},
  powerState?: Partial<TransportArgs[2]>,
  options?: Partial<TransportArgs[3]>,
): DeviceTransport {
  // One read of the caller's dispatcher decides both branches. Spreading
  // `options` over a default instead would let an explicit
  // `observedStateDispatcher: undefined` blank the dispatcher while still
  // reading as "caller injected nothing" — a transport that throws on its first
  // dispatch AND a subscribe helper attached to an emitter nothing reaches.
  const { observedStateDispatcher: injected, retainedPowerStore, ...rest } = options ?? {};
  const onSnapshotMutated = options?.onSnapshotMutated ?? (() => undefined);
  // A fresh in-memory store per transport unless the spec passes one: a spec
  // that restarts a transport on the same store is how a restart is modelled.
  const store = retainedPowerStore ?? createRetainedPowerStore(openUserdataDatabase(IN_MEMORY_DATABASE));
  const owners = { ...testTransportOwners(inputs), meters: testTransportMeters(inputs.meters) };
  const resolvedPowerState = testPowerState(powerState);
  if (injected) {
    return new DeviceTransport(homey, logger, resolvedPowerState, {
      ...rest,
      ...owners,
      onSnapshotMutated,
      observedStateDispatcher: injected,
      retainedPowerStore: store,
    });
  }
  const emitter = new ObservedStateEmitter();
  const transport = new DeviceTransport(homey, logger, resolvedPowerState, {
    ...rest,
    ...owners,
    onSnapshotMutated,
    observedStateDispatcher: emitter.asDispatcher(new ObservedHomePower()),
    retainedPowerStore: store,
  });
  emitterByTransport.set(transport, emitter);
  return transport;
}

const emitterFor = (transport: DeviceTransport): ObservedStateEmitter => {
  const emitter = emitterByTransport.get(transport);
  if (!emitter) {
    throw new Error(
      'This transport was not built by createTestDeviceTransport, so it has no emitter to '
      + 'subscribe to. Build it with the harness, or subscribe to the dispatcher you injected.',
    );
  }
  return emitter;
};

/** Per-capability observed deltas (was `PLAN_LIVE_STATE_OBSERVED_EVENT`). */
export const onObservedState = (
  transport: DeviceTransport,
  listener: (event: ObservedStateChangedEvent) => void,
): void => { emitterFor(transport).onObservedStateChanged(listener); };

/** Full-snapshot refresh batches, as each commit delivers them. */
export const onObservedStateRefresh = (
  transport: DeviceTransport,
  listener: (event: ObservedStateRefreshEvent) => void,
): void => { emitterFor(transport).onObservedStateRefresh(listener); };

/** Control-state changes (was `OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT`). */
export const onObservedControlState = (
  transport: DeviceTransport,
  listener: (event: ObservedControlStateChangedEvent) => void,
): void => { emitterFor(transport).onObservedControlStateChanged(listener); };

/**
 * Start `transport` as the app does, its live feed connected to the test
 * socket (`liveFeedSocketHarness.ts`), so realtime frames reach it the way
 * Homey's would. Call it before the first refresh: like production, the feed
 * subscribes to the devices each committed refresh lists.
 */
export async function initWithLiveFeed(transport: DeviceTransport): Promise<void> {
  connectLiveFeed();
  await transport.init();
}

/**
 * Commit `devices` through the transport's real refresh, as if Homey's device
 * list (and its by-id route) answered with them, and return the committed
 * snapshot in the transport's own shape, so a spec can read the probe fields
 * the consumer type omits.
 *
 * It installs the REST client itself, because a spec may have replaced the
 * default, and serves `devices` only for this one refresh: afterwards every
 * route, the device list included, answers from `mockHomeyInstance.api` again,
 * as the default client does. The live feed's subscriptions for the committed
 * devices are settled before it returns.
 */
export async function seedTransportDevices(
  transport: DeviceTransport,
  devices: readonly HomeyDeviceLike[],
  options: Partial<SnapshotRefreshOptions> = {},
): Promise<TransportDeviceSnapshot[]> {
  const served = new Map(devices.map((device) => [device.id, device]));
  let serving = true;
  setRestClient({
    get: async (path) => {
      if (serving && path === DEVICES_API_PATH) return Object.fromEntries(served);
      const byId = serving && path.startsWith(`${DEVICES_API_PATH}/`) ? path.slice(DEVICES_API_PATH.length + 1) : null;
      if (byId !== null && !byId.includes('/')) {
        const device = served.get(byId);
        if (!device) throw new Error(`Mock API GET 404 for device: ${byId}`);
        return device;
      }
      return mockHomeyInstance.api.get(path);
    },
    put: (path, body) => mockHomeyInstance.api.put(path, body),
  });
  try {
    await transport.refreshSnapshot({
      mainMeterSelection: { state: 'unavailable' },
      includeLivePower: false,
      ...options,
    });
  } finally {
    serving = false;
  }
  await settleLiveFeed();
  return transport.getSnapshot().flatMap((device) => transport.getSnapshotByDeviceId(device.id) ?? []);
}
