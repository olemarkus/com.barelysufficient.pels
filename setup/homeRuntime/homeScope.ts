/**
 * Per-home closure bundle for the plan factories
 * (`setup/appInit/createPlanEngine.ts`, `setup/appInit/createPlanService.ts`).
 *
 * Today the app runs exactly one home (`MAIN_HOME_ID`); the factories used to
 * hardwire singleton closures over `AppContext`. `HomeScope` lifts those
 * closures into an injected bundle so the multi-home follow-up can construct
 * N engines/services, each with per-home closures, without touching the
 * factories again. `buildMainHomeScope` reproduces the exact pre-refactor
 * closures: same live `ctx` reads, same unsuffixed settings keys
 * (`homeScopedSettingsKey` is the identity for the main home).
 */
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { HomeId } from '../../lib/power/capacitySettingsStore';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { buildPelsStatus } from '../../lib/plan/pelsStatus';
import type { AppContext } from '../../lib/app/appContext';
// Direct file imports (not the `setup/appInit.ts` barrel): the barrel also
// exports the plan factories, which import this module — going through the
// barrel would create a module cycle.
import { evictMissingDeviceCacheEntries, toPlanDevice } from '../appInit/toPlanDevice';
import { isRuntimePlannedDevice } from '../appDeviceSupport';
import {
  CAPACITY_IN_SHORTFALL,
  DEVICE_LAST_CONTROLLED_MS,
  MAIN_HOME_ID,
  PELS_STATUS,
  homeScopedSettingsKey,
} from '../../lib/utils/settingsKeys';

/**
 * The closure bundle one home hands to its plan engine/service factories.
 * Every member is a live closure (re-read on each call), matching the
 * pre-existing wiring semantics.
 */
export type HomeScope = {
  homeId: HomeId;
  // Capacity scalars: for the MAIN home these are live reads of the in-memory
  // snapshot (settings-handler maintained); sub-home scopes (R7b) will back
  // them with a per-home `CapacitySettingsStore` as their ONLY capacity source.
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  getCapacityGuard: () => CapacityGuard | undefined;
  getPowerTracker: () => PowerTrackerState;
  getDailyBudgetSnapshot: () => DailyBudgetUiPayload | null;
  getPlanDevices: () => PlanInputDevice[];
  // Persisted-signal writers. Each writes this home's key
  // (`homeScopedSettingsKey(base, homeId)` — the bare key for the main home).
  setCapacityInShortfall: (inShortfall: boolean) => void;
  persistLastControlledMs: (lastControlledMs: Record<string, number>) => void;
  writePelsStatus: (status: ReturnType<typeof buildPelsStatus>['status']) => void;
};

/**
 * The main home's scope: closures over the exact same `ctx` fields and the
 * exact same (unsuffixed) settings keys the factories hardwired before this
 * bundle existed. Zero behavior change by construction.
 */
export function buildMainHomeScope(ctx: AppContext): HomeScope {
  const homeId: HomeId = MAIN_HOME_ID;
  return {
    homeId,
    // Live snapshot reads — NOT re-reads through the settings store. The
    // snapshot is the in-memory truth kept current by the settings handler.
    getCapacitySettings: () => ctx.capacitySettings,
    getCapacityDryRun: () => ctx.capacityDryRun,
    getCapacityGuard: () => ctx.capacityGuard,
    getPowerTracker: () => ctx.powerTracker,
    getDailyBudgetSnapshot: () => ctx.dailyBudgetService?.getSnapshot() ?? null,
    getPlanDevices: () => {
      // Boot/hot-plug seed of the observed-state projection from the RAW cached
      // snapshot BEFORE the per-device `toPlanDevice` reads run. The projection
      // is event-driven (empty until the first delta/refresh for a device), so
      // on the first cold-start cycle — and for a device hot-plugged before its
      // first observation — `getObservedState` would otherwise be empty here and
      // `toPlanDevice` would fall back to the snapshot. Seeding fills only empty
      // slots (never clobbers a recorded observation) and uses the raw cached
      // array, so it adds no re-decoration and no device-manager re-entry.
      ctx.seedObservedStateFromSnapshot();
      const snapshot = ctx.latestTargetSnapshot;
      evictMissingDeviceCacheEntries(ctx, snapshot);
      return snapshot
        .map((device) => toPlanDevice(ctx, device))
        // Shared planned-set predicate — the create-smart-task candidate list
        // and create-time validation use the SAME `isRuntimePlannedDevice` so a
        // `managed: false` device can never be offered/persisted but unplanned.
        .filter(isRuntimePlannedDevice);
    },
    setCapacityInShortfall: (inShortfall) => (
      ctx.homey.settings.set(homeScopedSettingsKey(CAPACITY_IN_SHORTFALL, homeId), inShortfall)
    ),
    persistLastControlledMs: (lastControlledMs) => (
      ctx.homey.settings.set(homeScopedSettingsKey(DEVICE_LAST_CONTROLLED_MS, homeId), lastControlledMs)
    ),
    writePelsStatus: (status) => (
      ctx.homey.settings.set(homeScopedSettingsKey(PELS_STATUS, homeId), status)
    ),
  };
}
