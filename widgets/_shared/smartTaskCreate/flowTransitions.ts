import { resolveCreateSmartTaskRejectCopy } from '../../../packages/shared-domain/src/deadlineLabels';
import { canCreateFromPreview } from './flowRender';
import type { ComposeOrigin, FlowTargets, FlowView } from './flowView';
import type {
  CreateSmartTaskCandidateRequest,
  CreateSmartTaskDevice,
  CreateSmartTaskQuickTarget,
  CreateSmartTaskQuickTargetsResponse,
} from './types';

// The ready-by time the goal form opens with: the next 07:00, the usual
// morning the EV and the water heater are wanted by. The quick targets already
// cover "as soon as reasonable"; the form is for a time of the user's own.
const CREATE_SMART_TASK_DEFAULT_READY_BY = '07:00';

// Pure view transitions and request builders (no closure state) so the
// controller's click handlers stay one-liners. Each transition returns the next
// view, or the current view unchanged when the action doesn't apply to it.

export const initialComposeView = (
  device: CreateSmartTaskDevice,
  origin: ComposeOrigin,
  start?: CreateSmartTaskQuickTarget,
): Extract<FlowView, { kind: 'compose' }> => ({
  kind: 'compose',
  device,
  origin,
  // Customize opens on the selected quick target's goal. Not its time: the form
  // resolves a bare HH:mm to the next occurrence, which may be a day earlier
  // than the box's deadline, so it opens at the default ready-by instead.
  goal: start?.target ?? device.defaultGoal,
  readyByLocalTime: CREATE_SMART_TASK_DEFAULT_READY_BY,
  // Extra permissions always start off — a fresh device choice never inherits a
  // prior task's opt-ins.
  exemptFromBudget: false,
  limitLowerPriorityDevices: false,
});

export const steppedGoalView = (view: FlowView, direction: 1 | -1): FlowView => {
  if (view.kind !== 'compose') return view;
  const { device, goal } = view;
  if (goal === null) return view;
  const next = Math.round((goal + direction * device.goalStep) * 100) / 100;
  return { ...view, goal: Math.min(device.goalMax, Math.max(device.goalMin, next)) };
};

// Pure transitions (mirror steppedGoalView). The two permissions are independent.
export const budgetToggledView = (view: FlowView, checked: boolean): FlowView => {
  if (view.kind !== 'compose') return view;
  return { ...view, exemptFromBudget: checked };
};

export const limitToggledView = (view: FlowView, checked: boolean): FlowView => {
  if (view.kind !== 'compose') return view;
  return { ...view, limitLowerPriorityDevices: checked };
};

export const quickSelectedView = (view: FlowView, index: number): FlowView => {
  if (view.kind !== 'quick' || view.quick.kind !== 'ready' || view.submitting) return view;
  if (index < 0 || index >= view.quick.targets.length) return view;
  return { ...view, quick: { ...view.quick, selected: index }, error: null };
};

export const customizeView = (view: FlowView): FlowView => {
  if (view.kind !== 'quick' || view.quick.kind !== 'ready' || view.submitting) return view;
  return initialComposeView(view.device, { kind: 'quick', quick: view.quick }, view.quick.targets[view.quick.selected]);
};

// "Back" steps preview→compose (keeping the candidate), compose→the step it was
// opened from, or out of the flow from its first step (`null`). The quick step
// comes back as it was timed: re-timing it runs the planner again for every box.
export const backView = (view: FlowView): FlowView | null => {
  if (view.kind === 'compose' && view.origin.kind === 'quick') {
    return { kind: 'quick', device: view.device, quick: view.origin.quick, submitting: false, error: null };
  }
  if (view.kind === 'preview') {
    return {
      kind: 'compose',
      device: view.device,
      origin: view.origin,
      goal: view.goal,
      readyByLocalTime: view.readyByLocalTime,
      // Keep the opt-in extra permissions when stepping back to edit the goal.
      exemptFromBudget: view.exemptFromBudget,
      limitLowerPriorityDevices: view.limitLowerPriorityDevices,
    };
  }
  return null;
};

// Build the request from the in-progress compose/preview view (both carry the
// device, goal, ready-by, and opt-in permissions). `deadlineAtMs` is the
// previewed deadline echoed back on create so the persisted task matches the
// previewed window exactly (server-validated); omitted for the preview call.
// Only opted-in permissions are sent (omitted when off); the server re-gates
// limit-lower-priority against the device, so this is intent, not authority.
export const buildCandidateRequest = (
  source: Extract<FlowView, { kind: 'compose' | 'preview' }>,
  deadlineAtMs?: number,
): CreateSmartTaskCandidateRequest | null => source.goal === null ? null : ({
  deviceId: source.device.deviceId,
  kind: source.device.kind,
  target: source.goal,
  readyByLocalTime: source.readyByLocalTime,
  ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
  ...(source.exemptFromBudget ? { exemptFromBudget: true } : {}),
  ...(source.limitLowerPriorityDevices ? { limitLowerPriorityDevices: true } : {}),
});

// Start on a quick target: the target and the deadline it was timed to, echoed
// back so the created task is exactly the box the user tapped.
export const buildQuickTargetRequest = (
  device: CreateSmartTaskDevice,
  target: CreateSmartTaskQuickTarget,
): CreateSmartTaskCandidateRequest => ({
  deviceId: device.deviceId,
  kind: device.kind,
  target: target.target,
  readyByLocalTime: target.readyByLocalTime,
  deadlineAtMs: target.deadlineAtMs,
});

export const editedInputView = (view: FlowView, target: EventTarget | null, targets: FlowTargets): FlowView => {
  if (view.kind !== 'compose') return view;
  if (target === targets.goalValueEl) {
    const value = targets.goalValueEl.valueAsNumber;
    return { ...view, goal: Number.isFinite(value) ? value : null };
  }
  if (target === targets.readyByInput) return { ...view, readyByLocalTime: targets.readyByInput.value };
  return view;
};


const quickLoadingView = (device: CreateSmartTaskDevice): FlowView => (
  { kind: 'quick', device, quick: { kind: 'loading' }, submitting: false, error: null }
);

// The flow opens a device on its quick targets, or on the goal form when it
// offers none.
export const flowStartView = (device: CreateSmartTaskDevice): FlowView => (
  device.offersQuickTargets ? quickLoadingView(device) : initialComposeView(device, { kind: 'entry' })
);

// The quick step once its targets are timed. Nothing to offer (no target can be
// timed, or none finishes within the priced window) opens the goal form
// instead, whose Back then leaves the flow. A refused request (the
// device moved to a separate meter, the app unreachable) stays on the step and
// says why, with Customize still there.
export const quickTargetsLoadedView = (
  view: Extract<FlowView, { kind: 'quick' }>,
  response: CreateSmartTaskQuickTargetsResponse,
): FlowView => {
  if (response.state === 'rejected') {
    return {
      ...view, quick: { kind: 'ready', targets: [], selected: 0 },
      error: resolveCreateSmartTaskRejectCopy(response.reason),
    };
  }
  return response.state === 'ready' && response.targets.length > 0
    ? { ...view, quick: { kind: 'ready', targets: response.targets, selected: 0 } }
    : initialComposeView(view.device, { kind: 'entry' });
};

// What Create (on the preview) or Start (on a quick target) sends, or null when
// the current step cannot submit. A preview echoes the deadline it resolved, so
// the created task matches the previewed window exactly (server-validated).
export const submittableRequest = (view: FlowView): CreateSmartTaskCandidateRequest | null => {
  if (view.kind === 'preview') {
    if (view.submitting || !canCreateFromPreview(view.response) || !view.response.ok) return null;
    return buildCandidateRequest(view, view.response.deadlineAtMs);
  }
  if (view.kind !== 'quick' || view.quick.kind !== 'ready' || view.submitting) return null;
  const target = view.quick.targets[view.quick.selected];
  return target ? buildQuickTargetRequest(view.device, target) : null;
};
