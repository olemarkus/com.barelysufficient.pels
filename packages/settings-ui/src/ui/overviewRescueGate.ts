import {
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_STARVATION_RESCUE_DEVICES_PATH,
} from '../../../contracts/src/settingsUiApi.ts';
import { invalidateApiCache } from './homey.ts';
import { loadStarvationRescuableDevices } from './starvationRescue.ts';
import { refreshPlan, renderPlan, type PlanSnapshot } from './plan.ts';

// Owns the sequence-guard for the Overview "Let it run now" rescue chip's gate
// (`state.starvationRescuableDeviceIds`). Two realtime paths refresh that gate —
// a `plan_updated` push and opening the Overview tab — and both repaint the
// Overview after an ASYNC gate fetch. Without a guard, a slow OLDER fetch could
// resolve after a NEWER plan already rendered and roll the Overview back to a
// stale snapshot. A monotonically increasing token lets only the latest in-flight
// refresh repaint, so the latest plan always wins.
let generation = 0;

// Guard a `plan_updated` repaint: bump the token, then after the gate fetch
// resolves only repaint with THIS plan if no newer refresh has run since. The
// caller still paints the freshest plan synchronously; this only swaps in the
// chip gate once it loads, for the plan that is still current. `isOverviewVisible`
// is read at resolve-time so a tab switch away mid-fetch drops the repaint.
export const repaintOverviewWithRescueGate = (
  plan: PlanSnapshot | null,
  isOverviewVisible: () => boolean,
): Promise<void> => {
  const token = ++generation;
  return loadStarvationRescuableDevices().then(() => {
    if (token !== generation) return;
    if (isOverviewVisible()) renderPlan(plan);
  });
};

// Opening Overview must refresh the gate alongside the plan: a device that became
// budget-held while the user was on another tab never had its gate updated (the
// `plan_updated` refresh is Overview-only), so a fresh plan would otherwise render
// against a stale gate — missing a newly-rescuable chip, or leaving a stale one.
// Load the gate first, then refresh the plan so its render reflects the fresh
// gate. Bumps the same token so a concurrent in-flight gate fetch can't repaint a
// stale snapshot over this.
export const refreshOverviewPlanWithRescueGate = (): Promise<void> => {
  invalidateApiCache(SETTINGS_UI_PLAN_PATH);
  invalidateApiCache(SETTINGS_UI_STARVATION_RESCUE_DEVICES_PATH);
  ++generation;
  // The gate loader already swallows + logs its own fetch errors, but guard the
  // chain so a transient gate failure can NEVER skip the plan refresh — opening
  // Overview must always re-render the latest plan, gate or no gate.
  return loadStarvationRescuableDevices().catch(() => {}).then(() => refreshPlan());
};
