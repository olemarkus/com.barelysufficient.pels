import type { AppContext } from '../../lib/app/appContext';
import type { ObservedDeviceStateRefreshPayload } from '../../packages/contracts/src/observedDeviceState';
import type { TeardownRegistry } from '../../lib/utils/teardownRegistry';
import { HomeBatteryControlOwner } from '../../lib/battery/batteryControlOwner';
import type { BatteryControlOwner, StorageLaneBinding } from '../../lib/ports/batteryControlOwner';
import { buildDeviceActuator } from './buildDeviceActuator';
import { requireBatteryControl, requireDeviceManager } from './contextGuards';
import { bindSettledMainHomeMember } from './mainHomeMembership';

/**
 * The Main home's battery control owner, constructed with the reads it owns
 * policy over. Main only in v1: the owner refuses a claim for any battery
 * that is not a Main-home member on settled membership
 * (`isSettledMainHomeMember`, bound in `mainHomeMembership.ts`). Membership is
 * published by its own startup step and cleared at app stop, so it is read per
 * call, like Main's write fence reads it.
 *
 * Hand-backs go through the device actuator without Main's fence, which the
 * owner applies to claims only (see its header for why hand-back is exempt).
 * `isActuationFenced` is Main's write fence, the same one its plan actuator
 * reads.
 */
export const createMainBatteryControl = (
  ctx: AppContext,
  isActuationFenced: () => boolean,
): BatteryControlOwner => {
  const deviceManager = requireDeviceManager(ctx);
  const actuator = buildDeviceActuator(ctx);
  if (!actuator) throw new Error('Device actuator must be initialized before battery control setup.');
  return new HomeBatteryControlOwner(
    ctx.homey.settings,
    ctx.batteryManaged,
    actuator,
    (deviceId) => deviceManager.readBatteryControl(deviceId),
    bindSettledMainHomeMember(ctx),
    isActuationFenced,
    () => ctx.capacityDryRun,
  );
};

/** Held in the teardown registry; `runUninit` clears it to detach the snapshot feed. */
export const BATTERY_CONTROL_TEARDOWN_KEY = 'batteryControl';

/** The app-wiring handles the battery control step connects; `AppServiceWiring` hands its own deps. */
export type BatteryControlWiringDeps = {
  ctx: AppContext;
  teardown: TeardownRegistry;
  getObservedStateEmitter: () => {
    onObservedStateRefresh(listener: (refresh: ObservedDeviceStateRefreshPayload) => void): () => void;
  };
};

/**
 * Startup step: build Main's battery control owner, publish it on `ctx`, and
 * feed it every committed device snapshot (its prune and retry pass, boot
 * recovery included). The feed's detach is registered for `runUninit`; there
 * is no hand-back at app stop (the owner's header says why).
 */
export const initMainBatteryControl = (
  deps: BatteryControlWiringDeps,
  isActuationFenced: () => boolean,
): void => {
  const { ctx } = deps;
  const owner = createMainBatteryControl(ctx, isActuationFenced);
  // eslint-disable-next-line functional/immutable-data -- shared AppContext write
  ctx.batteryControl = owner;
  deps.teardown.register(BATTERY_CONTROL_TEARDOWN_KEY, deps.getObservedStateEmitter().onObservedStateRefresh(
    (refresh) => owner.onSnapshotCommitted(refresh),
  ));
};

/**
 * Main's storage lane over its battery control owner. `initMainBatteryControl`
 * runs before the plan stack, so the owner is a required dependency here.
 */
export const mainStorageLane = (ctx: AppContext): StorageLaneBinding => (
  { kind: 'battery_control', owner: requireBatteryControl(ctx) }
);
