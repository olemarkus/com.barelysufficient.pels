import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';

// Intentional ordering + grouping for the "New smart task" device picker.
//
// The picker only ever lists PELS-managed devices that can carry a smart task
// (an EV charge-level goal or a temperature goal). Alphabetical-by-name made
// that subset read as a random grab-bag. Instead we group devices by the two
// families the runtime can reliably tell apart — heating/temperature devices
// and EV chargers — and sort by name within each group, so the list reads as
// deliberately organised and a per-row type icon reinforces the grouping.
//
// We deliberately do NOT split water heaters from thermostats: the device
// manager normalizes every class into a fixed set that has no water-heater
// class (a Høiax-style water heater arrives as `heater`), so the snapshot
// can't distinguish a water heater from a space thermostat. The reliable
// signal is the smart-task kind (`ev_soc` vs temperature), so that is what we
// group by.
//
// Lives in shared-domain (browser-safe) so the create-smart-task widget payload
// builder is the single owner of the order; the group labels double as the row
// icon keys and are reusable copy per `feedback_ui_text_shared_with_logs`.

// The two device families a smart task can target, in display order: heating
// (the common case) first, EV chargers (heaviest/rarest) last.
export type SmartTaskDeviceGroup = 'heating' | 'ev_charger';

export const SMART_TASK_DEVICE_GROUP_ORDER: readonly SmartTaskDeviceGroup[] = [
  'heating',
  'ev_charger',
] as const;

// Structural input — the relevant slice of the device snapshot. Grouping keys
// off the already-resolved smart-task `kind` only (see the header note on why
// device class can't reliably distinguish water heaters from thermostats).
export type SmartTaskDevicePickerLike = {
  kind: DeferredObjectiveSettingsKind;
};

// Resolve which display group a smart-task-eligible device belongs to: an EV
// charge-level goal (`ev_soc`) is an EV charger; every temperature goal is a
// heating device.
export const resolveSmartTaskDeviceGroup = (
  device: SmartTaskDevicePickerLike,
): SmartTaskDeviceGroup => (
  device.kind === 'ev_soc' ? 'ev_charger' : 'heating'
);

// Picker copy that belongs with the ordering, kept out of the shared
// deadline-labels barrel. The caption explains the otherwise-unexplained subset
// (why the user's other Homey devices aren't listed); the per-group icon labels
// double as accessible names for the row type icons.
export const SMART_TASK_DEVICE_PICKER_COPY = {
  // One-line eligibility hint under "Choose a device" — a smart task is a goal
  // on a device PELS manages, so only those appear here. Frames the subset as
  // intentional rather than a mystery.
  eligibilityCaption: 'Only devices PELS manages can carry a smart task.',
  groupIconLabels: {
    heating: 'Heating',
    ev_charger: 'EV charger',
  } satisfies Record<SmartTaskDeviceGroup, string>,
} as const;

export const resolveSmartTaskDeviceGroupIconLabel = (
  group: SmartTaskDeviceGroup,
): string => SMART_TASK_DEVICE_PICKER_COPY.groupIconLabels[group];

// Precomputed group → rank map for O(1) comparator lookups (avoids an O(N)
// `indexOf` scan per comparison during sort). Derived from the order array so
// it stays a single source of truth.
const GROUP_RANK: Record<SmartTaskDeviceGroup, number> = Object.fromEntries(
  SMART_TASK_DEVICE_GROUP_ORDER.map((group, index) => [group, index]),
) as Record<SmartTaskDeviceGroup, number>;

const groupRank = (group: SmartTaskDeviceGroup): number => GROUP_RANK[group];

// Comparator for the picker: group first (in the intentional order above), then
// device name within a group. Callers pass the resolved group so the comparator
// stays a pure, name-aware tiebreak.
export const compareSmartTaskPickerRows = (
  a: { group: SmartTaskDeviceGroup; deviceName: string },
  b: { group: SmartTaskDeviceGroup; deviceName: string },
): number => {
  const byGroup = groupRank(a.group) - groupRank(b.group);
  if (byGroup !== 0) return byGroup;
  return a.deviceName.localeCompare(b.deviceName);
};
