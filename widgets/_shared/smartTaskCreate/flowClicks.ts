import { closestDataValue } from '../widgetDom';
import type { FlowTargets, FlowView } from './flowView';
import {
  budgetToggledView,
  customizeView,
  limitToggledView,
  quickSelectedView,
  steppedGoalView,
} from './flowTransitions';

// Discriminated action a click maps to. Pure resolution (no closure state) so
// the controller's dispatcher stays small and the mapping is unit-testable.
export type FlowClickAction =
  | { kind: 'select-quick'; index: number }
  | { kind: 'quick-customize' }
  | { kind: 'goal-dec' }
  | { kind: 'goal-inc' }
  | { kind: 'toggle-budget' }
  | { kind: 'toggle-limit' }
  | { kind: 'preview' }
  // Create on the preview and Start on a quick target: the view decides what is sent.
  | { kind: 'submit' }
  | { kind: 'back' };

// The click actions that only move between views, with no request or I/O.
const VIEW_CLICK_KINDS = [
  'select-quick', 'quick-customize', 'goal-dec', 'goal-inc', 'toggle-budget', 'toggle-limit',
] as const;
export type ViewClickAction = Extract<FlowClickAction, { kind: typeof VIEW_CLICK_KINDS[number] }>;

// Exhaustiveness guard for the controller's dispatcher: a new FlowClickAction it
// does not handle is a type error at the call.
export const assertUnhandledClick = (action: never): void => {
  void action;
};

export const isViewClickAction = (action: FlowClickAction): action is ViewClickAction => (
  (VIEW_CLICK_KINDS as readonly string[]).includes(action.kind)
);

export const clickedView = (action: ViewClickAction, view: FlowView, targets: FlowTargets): FlowView => {
  switch (action.kind) {
    case 'select-quick': return quickSelectedView(view, action.index);
    case 'quick-customize': return customizeView(view);
    case 'goal-dec': return steppedGoalView(view, -1);
    case 'goal-inc': return steppedGoalView(view, 1);
    case 'toggle-budget': return budgetToggledView(view, targets.permBudgetInput.checked);
    case 'toggle-limit': return limitToggledView(view, targets.permLimitInput.checked);
    default: {
      const unhandled: never = action; // exhaustiveness guard: a new view action is a type error here
      return unhandled;
    }
  }
};

const resolveQuickFlowClickAction = (eventTarget: Element): FlowClickAction | null => {
  const quickIndex = closestDataValue(eventTarget, '[data-quick-target]', 'quickIndex');
  if (quickIndex) return { kind: 'select-quick', index: Number(quickIndex) };
  if (eventTarget.closest('[data-quick-start]')) return { kind: 'submit' };
  if (eventTarget.closest('[data-quick-customize]')) return { kind: 'quick-customize' };
  return null;
};

export const resolveFlowClickAction = (eventTarget: EventTarget | null): FlowClickAction | null => {
  if (!(eventTarget instanceof Element)) return null;
  const quickAction = resolveQuickFlowClickAction(eventTarget);
  if (quickAction) return quickAction;
  if (eventTarget.closest('[data-goal-dec]')) return { kind: 'goal-dec' };
  if (eventTarget.closest('[data-goal-inc]')) return { kind: 'goal-inc' };
  // Checkbox `click` fires AFTER the native toggle, so the handler reads the new
  // `.checked` rather than flipping it — idempotent if a label-forwarded click
  // also lands.
  if (eventTarget.closest('[data-perm-budget-input]')) return { kind: 'toggle-budget' };
  if (eventTarget.closest('[data-perm-limit-input]')) return { kind: 'toggle-limit' };
  if (eventTarget.closest('[data-preview-btn]')) return { kind: 'preview' };
  if (eventTarget.closest('[data-create-btn]')) return { kind: 'submit' };
  if (eventTarget.closest('[data-quick-back]') || eventTarget.closest('[data-compose-back]')
    || eventTarget.closest('[data-preview-back]')
    || eventTarget.closest('[data-preview-edit]')) {
    return { kind: 'back' };
  }
  return null;
};

