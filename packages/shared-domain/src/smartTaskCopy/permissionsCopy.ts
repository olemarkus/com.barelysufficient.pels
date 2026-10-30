// Extra permissions and the power guarantee: the labels and hints every
// surface that grants or reads back a smart task's permissions shares.
import type { DeferredObjectivePlanPreviewEstimate } from '../../../contracts/src/deferredObjectivePlanPreview';
import type {
  DeferredObjectiveRescueMode,
  DeferredObjectiveRescuePermissions,
} from '../../../contracts/src/deferredObjectiveSettings';

// ─── Extra permissions: strings shared by every surface that SETS them ───────
// The create-smart-task widget, the smart-task detail editor, and the Held-back
// devices confirm sheet all show these, so they are surface-neutral by name —
// filing them under a widget-scoped record would mean someone tuning the widget
// silently re-words the editor and its log breadcrumbs.
export const SMART_TASK_EXTRA_PERMISSIONS_TITLE = 'Extra permissions';

// Read-only row label on the smart-task detail (`DeadlinePlan.tsx`) and list
// (`DeadlinesList.tsx`) surfaces. Carried no `(set via Flow)` qualifier since
// the detail page's editor gained its own permission toggles — the Flow card is
// one way to set these, no longer the only one, so naming it would send a user
// out to a Flow for something the row sits right beside. Lives here so the
// wording can't drift between surfaces and the runtime log breadcrumbs that
// share the same row label.
export const SMART_TASK_EXTRA_PERMISSIONS_ROW_LABEL = 'Extra permissions';

// Power is a conditional planning guarantee; the outcome also depends on
// the device's learned energy estimate.
export const SMART_TASK_GUARANTEE_COPY = {
  review: 'Review power guarantee',
  currentGuarantee: 'Current guarantee',
  changeGoal: 'Change target or deadline',
  powerReading: 'Latest power reading',
  conditions: 'The plan may reserve more in individual periods. This guarantee applies during scheduled operation '
    + 'if background and higher-priority usage follow the forecasts. House power limits still apply.',
  extraPower: 'Power beyond the plan’s reservations can help this task finish sooner.',
  reviewHint: 'A stronger guarantee may reserve more power or operating time for this task, '
    + 'leaving less for other devices. Changes are previewed before you save.',
  prioritiesAction: 'Review device priorities',
  prioritiesHint: 'Raising this device’s priority makes more devices yield to it. Their tasks may take longer.',
  learningDetails: 'Learning details',
  learningScope: 'These details describe the energy estimate, not the power guarantee. '
    + 'The last learning update is separate from the latest power reading.',
  learnedRate: 'Learned from previous operation.',
};

export const formatSmartTaskPriorityNote = (priority: number): string => (
  priority === 1
    ? 'No higher-priority devices are ahead of this device. '
      + 'Forecast background usage still reduces the available power.'
    : `Expected usage from ${priority === 2 ? 'priority 1 devices' : 'higher-priority devices'} is subtracted `
      + 'from the available power before power is reserved for this device.'
);

// The canonical user-facing names for the two rescue permissions. Exported so
// the create-smart-task widget's "Extra permissions" toggles, the settings-UI
// breadcrumb, and runtime log breadcrumbs all use the SAME wording — never an
// inlined duplicate (`feedback_ui_text_shared_with_logs`).
export const SMART_TASK_EXTRA_PERMISSION_LABELS: Record<keyof DeferredObjectiveRescuePermissions, string> = {
  exemptFromBudget: 'May go over daily budget',
  limitLowerPriorityDevices: 'May limit lower-priority devices',
  pauseLowerPriorityDevices: 'May reserve power to start sooner',
};

// One line per permission, for a surface where the user GRANTS one rather than
// reads back what is granted. Each says what it buys and what it costs the rest
// of the house, because "May reserve power to start sooner" on its own does not
// say whose power is held back, and a user may still read it as "PELS switches
// my devices off" — the misreading `notes/ui-terminology.md` warns about, and the
// reason the reserve line names the held-back devices and denies the switch-off
// in the same breath. Every line stays inside the hard cap
// (`feedback_hard_cap_is_physical`): these buy a task priority, never more power.
export const SMART_TASK_EXTRA_PERMISSION_HINTS: Record<keyof DeferredObjectiveRescuePermissions, string> = {
  exemptFromBudget: 'May reserve more operating time when the daily budget restricts this task. '
    + 'Energy use may exceed today’s budget; house power limits still apply.',
  // The cost is held-back devices, task or not: a lower-priority device need not belong to any
  // smart task, so naming only missed deadlines would understate it (owner, 2026-10-14).
  limitLowerPriorityDevices: 'May strengthen this task’s power guarantee by turning down lower-priority devices. '
    + 'They may be held back longer, and any smart tasks they have may miss their deadlines. '
    + 'The daily budget still applies.',
  pauseLowerPriorityDevices: 'Reserves power for this task to start. Lower-priority devices may be held back longer, '
    + 'and any smart tasks they have may miss their deadlines. This does not switch running devices off.',
};

const SMART_TASK_RESCUE_MODE_SUFFIX: Record<DeferredObjectiveRescueMode, string> = {
  always: '',
  at_risk: ' if at risk',
};

// Aliased from the contract rather than redeclared: a permission added to (or
// removed from) `grantedRescuePermissions` must break these helpers at compile
// time instead of silently compiling against a stale local copy.
export type GrantedRescuePermissions =
  NonNullable<DeferredObjectivePlanPreviewEstimate['grantedRescuePermissions']>;

// The canonical labels for the permissions that SURVIVED the per-device gate
// (`DeferredObjectivePlanPreviewEstimate.grantedRescuePermissions`), in the fixed
// budget → limit → pause order every surface lists them in. Derived from the
// GATED grant, never the pre-gate request, so a summary can't claim a permission
// the write won't persist — and never re-worded per surface: these are the SAME
// `SMART_TASK_EXTRA_PERMISSION_LABELS` the create widget's toggles and the
// smart-task detail row use. Single-homed here so the rescue widget's confirm
// sheet (which renders them as a list) and the settings-UI overview card (which
// renders the joined line below) cannot drift apart.
export const resolveGrantedRescuePermissionLabels = (
  granted: GrantedRescuePermissions | undefined,
): string[] => {
  if (!granted) return [];
  const labels: string[] = [];
  if (granted.exemptFromBudget) labels.push(SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget);
  if (granted.limitLowerPriorityDevices) {
    labels.push(SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices);
  }
  if (granted.pauseLowerPriorityDevices) {
    labels.push(SMART_TASK_EXTRA_PERMISSION_LABELS.pauseLowerPriorityDevices);
  }
  return labels;
};

// The one-line form for surfaces too compact for a list — the overview device
// card's armed rescue state. Same ` · ` separator and same order as
// `formatSmartTaskExtraPermissionsValue`, so what the user authorises on the card
// reads identically to the smart-task detail row they see afterwards. `null` when
// nothing was granted, so the line is suppressed cleanly instead of rendering an
// empty label.
export const formatGrantedRescuePermissionsLine = (
  granted: GrantedRescuePermissions | undefined,
): string | null => {
  const labels = resolveGrantedRescuePermissionLabels(granted);
  return labels.length > 0 ? labels.join(' · ') : null;
};

export const formatSmartTaskExtraPermissionsValue = (
  rescue: DeferredObjectiveRescuePermissions | undefined,
): string | null => {
  const parts: string[] = [];
  if (rescue?.exemptFromBudget) {
    parts.push(
      `${SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget}${SMART_TASK_RESCUE_MODE_SUFFIX[rescue.exemptFromBudget]}`,
    );
  }
  if (rescue?.limitLowerPriorityDevices) {
    parts.push(
      `${SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices}`
      + `${SMART_TASK_RESCUE_MODE_SUFFIX[rescue.limitLowerPriorityDevices]}`,
    );
  }
  if (rescue?.pauseLowerPriorityDevices) {
    parts.push(
      `${SMART_TASK_EXTRA_PERMISSION_LABELS.pauseLowerPriorityDevices}`
      + `${SMART_TASK_RESCUE_MODE_SUFFIX[rescue.pauseLowerPriorityDevices]}`,
    );
  }
  if (parts.length === 0) return null;
  return parts.join(' · ');
};
