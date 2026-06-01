// Canonical wording for the smart-task rescue Flow action cards: the
// `allow_smart_task_rescue` run-listener rejections (the constants below) plus
// the shared device-missing formatter used by the device-boolean cards
// (capacity control, budget exemption). Lives in shared-domain so the
// user-facing card error and any runtime log line emit identical text (Rule 4 /
// Rule 7, `notes/ui-terminology.md`) instead of drifting from an inline literal.

export const SMART_TASK_RESCUE_INVALID_PROPERTY = 'Choose what this smart task may do.';

export const SMART_TASK_RESCUE_INVALID_WHEN
  = 'Choose when this applies: at no time, or while the smart task is scheduled to run.';

export const SMART_TASK_RESCUE_MISSING_DEVICE = 'Device must be provided.';

export const SMART_TASK_RESCUE_NO_TASK = 'Add a smart task for this device first.';

// The device-boolean Flow action cards (capacity control, budget exemption)
// reject a missing device with a label-prefixed message. Lives here so the
// user-facing card error and any runtime log line emit identical text instead
// of drifting from an inline literal. Dynamic by `label`, so it's a formatter.
export function formatDeviceMustBeProvidedMessage(label: string): string {
  // `charAt(0)` (not `label[0]`) so an empty label degrades to a still-valid
  // message instead of throwing on `undefined.toUpperCase()`.
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} device must be provided`;
}
