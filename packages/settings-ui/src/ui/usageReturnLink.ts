import {
  SMART_TASK_USAGE_RETURN_CONTEXT,
  SMART_TASK_USAGE_RETURN_DEFAULT_HREF,
  SMART_TASK_USAGE_RETURN_LABEL,
} from '../../../shared-domain/src/deadlineLabels.ts';

type UsageReturnLinkState = {
  href: string;
  label: string;
  context: string;
};

const getElements = (): {
  root: HTMLElement | null;
  anchor: HTMLAnchorElement | null;
  label: HTMLElement | null;
  context: HTMLElement | null;
} => ({
  root: document.getElementById('usage-return-link'),
  anchor: document.getElementById('usage-return-link-anchor') as HTMLAnchorElement | null,
  label: document.getElementById('usage-return-link-label'),
  context: document.getElementById('usage-return-link-context'),
});

export const showUsageReturnLink = (state: UsageReturnLinkState): void => {
  const { root, anchor, label, context } = getElements();
  if (!root || !anchor || !label || !context) return;
  anchor.href = state.href;
  label.textContent = state.label;
  context.textContent = state.context;
  root.hidden = false;
};

export const clearUsageReturnLink = (): void => {
  const { root, anchor, label, context } = getElements();
  if (!root || !anchor || !label || !context) return;
  anchor.href = SMART_TASK_USAGE_RETURN_DEFAULT_HREF;
  label.textContent = SMART_TASK_USAGE_RETURN_LABEL;
  context.textContent = SMART_TASK_USAGE_RETURN_CONTEXT;
  root.hidden = true;
};
