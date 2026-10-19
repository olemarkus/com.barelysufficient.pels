import type {
  CreateSmartTaskDevice,
  CreateSmartTaskPreviewResponse,
  CreateSmartTaskQuickTarget,
} from './types';

// The quick-target step: loading while the app times each target, then the
// boxes with one selected. Start creates the selected target directly.
export type TimedQuickTargets = { kind: 'ready'; targets: CreateSmartTaskQuickTarget[]; selected: number };
export type QuickTargetsState = { kind: 'loading' } | TimedQuickTargets;

// Where "Back" from the goal form leads: the quick targets it was opened from,
// as they were timed, or out of the flow (to the widget that opened it) when
// the device offers none, or none could be timed.
export type ComposeOrigin = { kind: 'entry' } | { kind: 'quick'; quick: TimedQuickTargets };

// The creation flow walks four steps. `quick`, `compose` and `preview` carry
// the in-progress candidate so a re-render keeps the user's selections;
// `created` is a brief success flash before the flow closes.
export type FlowView =
  | {
    kind: 'quick';
    device: CreateSmartTaskDevice;
    quick: QuickTargetsState;
    submitting: boolean;
    error: string | null;
  }
  | {
    kind: 'compose';
    device: CreateSmartTaskDevice;
    origin: ComposeOrigin;
    // A cleared input stays a draft; preview requires a valid numeric goal.
    goal: number | null;
    readyByLocalTime: string;
    // Opt-in "Extra permissions", both default off and carried through
    // compose → preview → create so the user's choice survives a re-render and
    // the preview/create reflect it. `limitLowerPriorityDevices` is only
    // offered when the device can use it (`device.supportsLimitLowerPriority`).
    exemptFromBudget: boolean;
    limitLowerPriorityDevices: boolean;
  }
  | {
    kind: 'preview';
    device: CreateSmartTaskDevice;
    origin: ComposeOrigin;
    goal: number;
    readyByLocalTime: string;
    exemptFromBudget: boolean;
    limitLowerPriorityDevices: boolean;
    response: CreateSmartTaskPreviewResponse;
    submitting: boolean;
    error: string | null;
  }
  | { kind: 'created' };

// The flow's own markup: the four step sections and the quick-target template.
// Each widget that hosts the flow carries the identical markup
// (`test/unit/smartTaskCreateFlowMarkup.test.ts` holds them equal).
export type FlowTargets = {
  // Quick targets
  quickView: HTMLElement;
  quickBackBtn: HTMLButtonElement;
  quickTitle: HTMLElement;
  quickStatusEl: HTMLElement;
  quickList: HTMLElement;
  quickSummaryEl: HTMLElement;
  quickFinishEl: HTMLElement;
  quickErrorEl: HTMLElement;
  quickCustomizeBtn: HTMLButtonElement;
  quickStartBtn: HTMLButtonElement;
  quickTargetTemplate: HTMLTemplateElement;
  // Compose
  composeView: HTMLElement;
  composeBackBtn: HTMLButtonElement;
  composeTitle: HTMLElement;
  goalLabel: HTMLElement;
  goalValueEl: HTMLInputElement;
  goalUnitEl: HTMLElement;
  goalContextEl: HTMLElement;
  goalDecBtn: HTMLButtonElement;
  goalIncBtn: HTMLButtonElement;
  readyByLabel: HTMLElement;
  readyByInput: HTMLInputElement;
  readyByEchoEl: HTMLElement;
  composeErrorEl: HTMLElement;
  // Extra permissions disclosure
  extraPermsTitle: HTMLElement;
  extraPermsHint: HTMLElement;
  permBudgetInput: HTMLInputElement;
  permBudgetLabel: HTMLElement;
  permBudgetHint: HTMLElement;
  permLimitToggle: HTMLElement;
  permLimitInput: HTMLInputElement;
  permLimitLabel: HTMLElement;
  permLimitHint: HTMLElement;
  previewBtn: HTMLButtonElement;
  // Preview — task intent leads, followed by feasibility and estimates.
  previewView: HTMLElement;
  previewBackBtn: HTMLButtonElement;
  previewTitle: HTMLElement;
  previewDeviceEl: HTMLElement;
  previewGoalEl: HTMLElement;
  previewChartLegendEl: HTMLElement;
  previewChartPriceEl: HTMLElement;
  previewChartScheduledEl: HTMLElement;
  previewWarningHintEl: HTMLElement;
  previewFeasibilityEl: HTMLElement;
  previewCostEl: HTMLElement;
  previewCostSubtextEl: HTMLElement;
  previewChartEl: HTMLElement;
  previewWhenEl: HTMLElement;
  previewEnergyEl: HTMLElement;
  previewCaveatEl: HTMLElement;
  previewUnavailableEl: HTMLElement;
  previewErrorEl: HTMLElement;
  createBtn: HTMLButtonElement;
  previewEditBtn: HTMLButtonElement;
  // Created flash
  createdView: HTMLElement;
  createdMsgEl: HTMLElement;
};

const FLOW_ELEMENTS = {
  quickView: '[data-quick-view]',
  quickTitle: '[data-quick-title]',
  quickStatusEl: '[data-quick-status]',
  quickList: '[data-quick-list]',
  quickSummaryEl: '[data-quick-summary]',
  quickFinishEl: '[data-quick-finish]',
  quickErrorEl: '[data-quick-error]',
  composeView: '[data-compose-view]',
  composeTitle: '[data-compose-title]',
  goalLabel: '[data-goal-label]',
  goalUnitEl: '[data-goal-unit]',
  goalContextEl: '[data-goal-context]',
  readyByLabel: '[data-ready-by-label]',
  readyByEchoEl: '[data-ready-by-echo]',
  composeErrorEl: '[data-compose-error]',
  extraPermsTitle: '[data-extra-perms-title]',
  extraPermsHint: '[data-extra-perms-hint]',
  permBudgetLabel: '[data-perm-budget-label]',
  permBudgetHint: '[data-perm-budget-hint]',
  permLimitToggle: '[data-perm-limit]',
  permLimitLabel: '[data-perm-limit-label]',
  permLimitHint: '[data-perm-limit-hint]',
  previewView: '[data-preview-view]',
  previewTitle: '[data-preview-title]',
  previewDeviceEl: '[data-preview-device]',
  previewGoalEl: '[data-preview-goal]',
  previewChartLegendEl: '[data-preview-chart-legend]',
  previewChartPriceEl: '[data-preview-chart-price]',
  previewChartScheduledEl: '[data-preview-chart-scheduled]',
  previewWarningHintEl: '[data-preview-warning-hint]',
  previewFeasibilityEl: '[data-preview-feasibility]',
  previewCostEl: '[data-preview-cost]',
  previewCostSubtextEl: '[data-preview-cost-subtext]',
  previewChartEl: '[data-preview-chart]',
  previewWhenEl: '[data-preview-when]',
  previewEnergyEl: '[data-preview-energy]',
  previewCaveatEl: '[data-preview-caveat]',
  previewUnavailableEl: '[data-preview-unavailable]',
  previewErrorEl: '[data-preview-error]',
  createdView: '[data-created-view]',
  createdMsgEl: '[data-created-msg]',
} as const;

const FLOW_BUTTONS = {
  quickBackBtn: '[data-quick-back]',
  quickCustomizeBtn: '[data-quick-customize]',
  quickStartBtn: '[data-quick-start]',
  composeBackBtn: '[data-compose-back]',
  goalDecBtn: '[data-goal-dec]',
  goalIncBtn: '[data-goal-inc]',
  previewBtn: '[data-preview-btn]',
  previewBackBtn: '[data-preview-back]',
  createBtn: '[data-create-btn]',
  previewEditBtn: '[data-preview-edit]',
} as const;

const FLOW_INPUTS = {
  permBudgetInput: '[data-perm-budget-input]',
  permLimitInput: '[data-perm-limit-input]',
  goalValueEl: '[data-goal-value]',
  readyByInput: '[data-ready-by-input]',
} as const;

const queryAll = (d: Document, selectors: Record<string, string>): Record<string, Element | null> => (
  Object.fromEntries(Object.entries(selectors).map(([key, selector]) => [key, d.querySelector(selector)]))
);

/** The flow's elements in `d`, or null when any is missing from the markup. */
export const resolveFlowTargets = (d: Document): FlowTargets | null => {
  const quickTargetTemplate = d.getElementById('quick-target-template');
  const elements = queryAll(d, FLOW_ELEMENTS);
  const buttons = queryAll(d, FLOW_BUTTONS);
  const inputs = queryAll(d, FLOW_INPUTS);
  if (
    !(quickTargetTemplate instanceof HTMLTemplateElement)
    || Object.values(elements).some((el) => !(el instanceof HTMLElement))
    || Object.values(buttons).some((el) => !(el instanceof HTMLButtonElement))
    || Object.values(inputs).some((el) => !(el instanceof HTMLInputElement))
  ) {
    return null;
  }
  return { quickTargetTemplate, ...elements, ...buttons, ...inputs } as FlowTargets;
};
