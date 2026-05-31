import {
  type DeferredObjectiveRescueMode,
  type DeferredObjectiveRescuePermissions,
  type DeferredObjectiveSettingsEntry,
} from '../lib/objectives/deferredObjectives';
import {
  getDropdownId,
  requireSettingsRead,
  type DropdownArg,
} from './deadlineObjectiveCards';
import { OBJECTIVE_WRITE_REFUSED_RETRY } from '../packages/shared-domain/src/objectiveWriteStrings';
import { supportsSmartTaskObjective } from './smartTaskDeviceCapability';
import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';
import {
  SMART_TASK_RESCUE_INVALID_PROPERTY,
  SMART_TASK_RESCUE_INVALID_WHEN,
  SMART_TASK_RESCUE_MISSING_DEVICE,
  SMART_TASK_RESCUE_NO_TASK,
} from '../packages/shared-domain/src/smartTaskRescueStrings';
import type { FlowCardDeps } from './registerFlowCards';

type RescuePropertyId = 'exempt_from_budget' | 'limit_lower_priority';

const RESCUE_PROPERTY_KEYS: Record<RescuePropertyId, keyof DeferredObjectiveRescuePermissions> = {
  exempt_from_budget: 'exemptFromBudget',
  limit_lower_priority: 'limitLowerPriorityDevices',
};

const resolveRescuePropertyId = (raw: DropdownArg | undefined): RescuePropertyId => {
  const id = getDropdownId(raw);
  if (id === 'exempt_from_budget' || id === 'limit_lower_priority') return id;
  throw new Error(SMART_TASK_RESCUE_INVALID_PROPERTY);
};

// 'never' clears the permission; 'at_risk' / 'always' set the mode.
const resolveWhen = (raw: DropdownArg | undefined): DeferredObjectiveRescueMode | undefined => {
  const id = getDropdownId(raw);
  if (id === 'never') return undefined;
  if (id === 'at_risk' || id === 'always') return id;
  throw new Error(SMART_TASK_RESCUE_INVALID_WHEN);
};

// Rebuild the rescue permissions from the existing entry plus the single changed
// key, dropping the whole object when nothing is set so it matches the persisted
// schema shape (absent = off). No mutation, mirroring the settings normalizer.
const withRescuePermission = (
  entry: DeferredObjectiveSettingsEntry,
  key: keyof DeferredObjectiveRescuePermissions,
  mode: DeferredObjectiveRescueMode | undefined,
): DeferredObjectiveSettingsEntry => {
  const exemptFromBudget = key === 'exemptFromBudget' ? mode : entry.rescue?.exemptFromBudget;
  const limitLowerPriorityDevices = key === 'limitLowerPriorityDevices'
    ? mode
    : entry.rescue?.limitLowerPriorityDevices;
  const rescue: DeferredObjectiveRescuePermissions | undefined = exemptFromBudget || limitLowerPriorityDevices
    ? {
      ...(exemptFromBudget ? { exemptFromBudget } : {}),
      ...(limitLowerPriorityDevices ? { limitLowerPriorityDevices } : {}),
    }
    : undefined;
  return { ...entry, rescue };
};

export function registerAllowSmartTaskRescueCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard('allow_smart_task_rescue');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg; property?: DropdownArg; when?: DropdownArg } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) throw new Error(SMART_TASK_RESCUE_MISSING_DEVICE);
    const key = RESCUE_PROPERTY_KEYS[resolveRescuePropertyId(payload?.property)];
    const mode = resolveWhen(payload?.when);
    const settings = requireSettingsRead(deps)();
    const prevEntry = settings.objectivesByDeviceId[deviceId];
    if (!prevEntry) {
      throw new Error(SMART_TASK_RESCUE_NO_TASK);
    }
    // Idempotent: an unchanged mode means no write, no re-plan, no plan revision.
    if (prevEntry.rescue?.[key] === mode) return true;
    // Route the write through the device-scoped per-key op. `rescue: 'replace'`
    // makes the op write this entry's rescue field verbatim (including clearing
    // a permission to `undefined`) rather than preserving the prior one — this
    // card IS the authority on rescue. A rescue-only change keeps the same
    // kind/deadline/target, so the recorder notification no-ops; the plan
    // rebuild applies the new permission. A per-key write touches only this
    // device's key, so it cannot clobber a sibling task.
    const outcome = deps.upsertDeferredObjectiveForDevice({
      deviceId,
      deviceName: null,
      entry: withRescuePermission(prevEntry, key, mode),
      rescue: 'replace',
    });
    // A refused write (transient un-confirmable migration / untrustworthy
    // settings read) must surface as a retryable failure, not a silent success
    // that leaves the rescue permission unchanged.
    if (!outcome.persisted) throw new Error(OBJECTIVE_WRITE_REFUSED_RETRY);
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    // List smart-task-capable devices (temperature-deadline-capable or EV chargers), not just
    // devices that have a task right now — otherwise the flow can't be built before the task
    // exists. The run-listener guards the "no smart task yet" case at execution time.
    return buildDeviceAutocompleteOptions(snapshot.filter(supportsSmartTaskObjective), query);
  });
}
