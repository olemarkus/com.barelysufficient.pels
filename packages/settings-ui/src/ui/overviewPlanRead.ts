import {
  CAPACITY_DRY_RUN,
  MAIN_HOME_ID,
  homeScopedSettingsKey,
} from '../../../contracts/src/settingsKeys.ts';
import { resolveHomeScopedRead, type HomeScopedRead } from '../../../contracts/src/homeScopedRead.ts';
import { SETTINGS_UI_PLAN_PATH, type SettingsUiPlanPayload } from '../../../contracts/src/settingsUiApi.ts';
import { getApiReadModel, getSetting, homeScopedApiUri } from './homey.ts';
import { getHomeScope } from './homeScope.ts';
import { logSettingsError, logSettingsWarn } from './logging.ts';
import { parsePlanSnapshot } from './planSnapshotParse.ts';
import type { PlanSnapshot } from './planTypes.ts';

/**
 * What the Overview gets from a plan read: the payload's plan ALREADY resolved
 * to a snapshot. `plan: null` on a `served` read means one thing only — the
 * home has committed no plan yet — because every other reading of a null
 * (absent scope, wrong home, unreadable transport, malformed payload) is
 * classified `unavailable` before it reaches here. Consumers commit this value
 * directly; they must not re-parse it.
 */
export type OverviewPlanPayload = { readonly plan: PlanSnapshot | null };

/**
 * The Overview's scope-following `ui_plan` read (multi-home). Same contract as
 * the Usage surface's `readUsagePower` (which the Overview also reuses for its
 * power read):
 *
 * Main selection keeps the historical whole-home behaviour byte for byte — the
 * BARE `/ui_plan` URI, the same `apiCache` entry every existing invalidation
 * site (and the `plan_updated` realtime prime) targets, and an always-`served`
 * result whose plan is parsed exactly as the whole-home path always parsed it.
 *
 * A selected meter area reads the `?homeId=` variant and MUST discriminate the
 * producer's `homeScope` before any flat field: the scoped endpoint answers
 * every non-serving case with `plan: null` plus `unavailable`, so an
 * undiscriminated read could not tell "no data for this home" from a healthy
 * home that has not committed a plan yet. `resolveHomeScopedRead` makes the
 * flat fields unreachable until the scope is discriminated.
 */
export const readOverviewPlan = async (): Promise<HomeScopedRead<OverviewPlanPayload>> => {
  const { selectedHomeId } = getHomeScope();
  if (selectedHomeId === MAIN_HOME_ID) {
    const payload = await getApiReadModel<SettingsUiPlanPayload>(SETTINGS_UI_PLAN_PATH);
    return { state: 'served', payload: { plan: parsePlanSnapshot(payload?.plan) } };
  }
  // This adapter owns the COMPLETE classification of the scoped read — a
  // THROWN fetch included (root AGENTS.md, "Validation belongs at the
  // boundary"). Letting the rejection propagate would abort the caller's
  // refresh AFTER the scope pick already blanked the surface, stranding the
  // Overview on the loading skeleton; a read the runtime could not answer IS
  // the `unavailable` state (the `readUsagePower` precedent).
  try {
    const read = resolveHomeScopedRead(
      await getApiReadModel<SettingsUiPlanPayload>(
        homeScopedApiUri(SETTINGS_UI_PLAN_PATH, selectedHomeId),
      ),
      // The resolver refuses a resolved payload naming a DIFFERENT home — a
      // misrouted producer answer must never render another area's plan under
      // this scope's chip (the same guarantee the Usage reader carries).
      selectedHomeId,
    );
    if (read.state !== 'served') return read;
    // The resolver validates the ENVELOPE; the payload it carries is still
    // untrusted. A non-null `plan` that fails the shape guard is a malformed
    // producer answer, and collapsing it to `plan: null` would make the
    // Overview claim this area has committed no plan yet — a fabricated
    // verdict about a home whose plan we could not read. That is the
    // `unavailable` notice, the same as an empty envelope.
    const plan = parsePlanSnapshot(read.payload.plan);
    if (plan === null && read.payload.plan !== null && read.payload.plan !== undefined) {
      void logSettingsWarn('Ignoring a malformed meter area plan', undefined, 'overviewPlanRead');
      return { state: 'unavailable' };
    }
    return { state: 'served', payload: { plan } };
  } catch (caught) {
    void logSettingsError('Failed to read the meter area\'s plan', caught, 'overviewPlanRead');
    return { state: 'unavailable' };
  }
};

/**
 * A meter area's simulation posture for the Overview hero: its own persisted
 * `capacity_dry_run:<homeId>` flag, never Main's — the hero's "Simulation
 * mode" chip and hypothetical decision-sentence voice must describe the home
 * on screen. Mirrors `readAreaSimulationFlag` in `capacity.ts` (the aggregate
 * banner posture): an absent or non-boolean value is the runtime's
 * dry-run-TRUE boot default (a fresh area simulates until the owner turns on
 * control). A THROWN read also resolves to `true`, deliberately: claiming
 * simulation on a live area under-claims action (safe, heals on the next
 * repaint), while claiming live control on a simulating area would tell the
 * owner PELS acted when it did not.
 */
export const readAreaSimulationPosture = async (homeId: string): Promise<boolean> => {
  try {
    const raw = await getSetting(homeScopedSettingsKey(CAPACITY_DRY_RUN, homeId));
    return typeof raw === 'boolean' ? raw : true;
  } catch {
    return true;
  }
};
