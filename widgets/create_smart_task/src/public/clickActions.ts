import { closestDataValue } from '../../../_shared/widgetDom';
import type { RenderTargets, ViewState } from './render';
import {
  budgetToggledView,
  customizeView,
  limitToggledView,
  quickSelectedView,
  steppedGoalView,
} from './viewTransitions';

// Discriminated action a click maps to. Pure resolution (no closure state) so
// the controller's dispatcher stays small and the mapping is unit-testable.
export type ClickAction =
  | { kind: 'select-device'; deviceId: string }
  | { kind: 'select-quick'; index: number }
  | { kind: 'quick-start' }
  | { kind: 'quick-customize' }
  | { kind: 'goal-dec' }
  | { kind: 'goal-inc' }
  | { kind: 'toggle-budget' }
  | { kind: 'toggle-limit' }
  | { kind: 'preview' }
  | { kind: 'create' }
  | { kind: 'back' }
  | { kind: 'retry-load' };

// The click actions that only move between views, with no request or I/O.
// Null for an action the controller handles itself.
export const clickedView = (action: ClickAction, view: ViewState, targets: RenderTargets): ViewState | null => {
  switch (action.kind) {
    case 'select-quick': return quickSelectedView(view, action.index);
    case 'quick-customize': return customizeView(view);
    case 'goal-dec': return steppedGoalView(view, -1);
    case 'goal-inc': return steppedGoalView(view, 1);
    case 'toggle-budget': return budgetToggledView(view, targets.permBudgetInput.checked);
    case 'toggle-limit': return limitToggledView(view, targets.permLimitInput.checked);
    default: return null;
  }
};

const resolveQuickClickAction = (eventTarget: Element): ClickAction | null => {
  const quickIndex = closestDataValue(eventTarget, '[data-quick-target]', 'quickIndex');
  if (quickIndex) return { kind: 'select-quick', index: Number(quickIndex) };
  if (eventTarget.closest('[data-quick-start]')) return { kind: 'quick-start' };
  if (eventTarget.closest('[data-quick-customize]')) return { kind: 'quick-customize' };
  return null;
};

export const resolveClickAction = (eventTarget: EventTarget | null): ClickAction | null => {
  if (!(eventTarget instanceof Element)) return null;
  const deviceId = closestDataValue(eventTarget, '[data-device-button]', 'deviceId');
  if (deviceId) return { kind: 'select-device', deviceId };
  // Retry the device fetch in place after a load error (see the `error` payload
  // state) — re-runs loadAndRender so a stuck load recovers without a reopen.
  if (eventTarget.closest('[data-picker-retry]')) return { kind: 'retry-load' };
  const quickAction = resolveQuickClickAction(eventTarget);
  if (quickAction) return quickAction;
  if (eventTarget.closest('[data-goal-dec]')) return { kind: 'goal-dec' };
  if (eventTarget.closest('[data-goal-inc]')) return { kind: 'goal-inc' };
  // Checkbox `click` fires AFTER the native toggle, so the handler reads the new
  // `.checked` rather than flipping it — idempotent if a label-forwarded click
  // also lands.
  if (eventTarget.closest('[data-perm-budget-input]')) return { kind: 'toggle-budget' };
  if (eventTarget.closest('[data-perm-limit-input]')) return { kind: 'toggle-limit' };
  if (eventTarget.closest('[data-preview-btn]')) return { kind: 'preview' };
  if (eventTarget.closest('[data-create-btn]')) return { kind: 'create' };
  if (eventTarget.closest('[data-quick-back]') || eventTarget.closest('[data-compose-back]')
    || eventTarget.closest('[data-preview-back]')
    || eventTarget.closest('[data-preview-edit]')) {
    return { kind: 'back' };
  }
  return null;
};

