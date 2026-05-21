import {
  type DeferredObjectiveRescueMode,
  type DeferredObjectiveRescuePermissions,
  type DeferredObjectiveSettingsEntry,
} from '../lib/plan/deferredObjectives';
import {
  getDropdownId,
  requireSettingsAccessors,
  upsertObjective,
  type DropdownArg,
} from './deadlineObjectiveCards';
import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';
import type { FlowCardDeps } from './registerFlowCards';

type RescuePropertyId = 'exempt_from_budget' | 'limit_lower_priority';

const RESCUE_PROPERTY_KEYS: Record<RescuePropertyId, keyof DeferredObjectiveRescuePermissions> = {
  exempt_from_budget: 'exemptFromBudget',
  limit_lower_priority: 'limitLowerPriorityDevices',
};

const resolveRescuePropertyId = (raw: DropdownArg | undefined): RescuePropertyId => {
  const id = getDropdownId(raw);
  if (id === 'exempt_from_budget' || id === 'limit_lower_priority') return id;
  throw new Error('Choose which rescue permission to set.');
};

// 'never' clears the permission; 'at_risk' / 'always' set the mode.
const resolveWhen = (raw: DropdownArg | undefined): DeferredObjectiveRescueMode | undefined => {
  const id = getDropdownId(raw);
  if (id === 'never') return undefined;
  if (id === 'at_risk' || id === 'always') return id;
  throw new Error('Choose when this applies: never, or when the device is planned to run.');
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
    if (!deviceId) throw new Error('Device must be provided.');
    const propertyId = resolveRescuePropertyId(payload?.property);
    // limit-lower-priority is a forward-declared placeholder: the schema and this
    // card accept it, but the planner does not honour it yet (a follow-up wires the
    // lane). Reject it explicitly rather than silently storing a no-op that would
    // still log a "Flow changed what this task may use" plan revision.
    if (propertyId === 'limit_lower_priority') {
      throw new Error('Limiting lower-priority devices is not available yet.');
    }
    const key = RESCUE_PROPERTY_KEYS[propertyId];
    const mode = resolveWhen(payload?.when);
    const accessors = requireSettingsAccessors(deps);
    const settings = accessors.read();
    const prevEntry = settings.objectivesByDeviceId[deviceId];
    if (!prevEntry) {
      throw new Error('That device has no smart task yet — add a deadline first.');
    }
    // Idempotent: an unchanged mode means no write, no re-plan, no plan revision.
    if (prevEntry.rescue?.[key] === mode) return true;
    accessors.write(upsertObjective(settings, deviceId, withRescuePermission(prevEntry, key, mode)));
    deps.rebuildPlan('deadline_objective_rescue_set');
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    const activeIds = new Set(Object.keys(requireSettingsAccessors(deps).read().objectivesByDeviceId));
    return buildDeviceAutocompleteOptions(snapshot.filter((device) => activeIds.has(device.id)), query);
  });
}
