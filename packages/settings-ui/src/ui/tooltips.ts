import { delegate, hideAll } from 'tippy.js';

const TOOLTIP_SELECTOR = '[data-tooltip]';

const getTooltipContent = (reference: Element): string => {
  if (!(reference instanceof HTMLElement)) return '';
  const content = reference.dataset.tooltip;
  return content ? content.trim() : '';
};

export const setTooltip = (element: HTMLElement | null, content?: string | null): void => {
  if (!element) return;
  if (!content) {
    element.removeAttribute('data-tooltip');
    element.removeAttribute('title');
    return;
  }
  element.setAttribute('data-tooltip', content);
  element.removeAttribute('title');
};

const prefersTouch = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(hover: none), (pointer: coarse)').matches;
};

export const initTooltips = (): void => {
  if (typeof document === 'undefined' || !document.body) return;

  const useTouch = prefersTouch();
  const trigger = useTouch ? 'click' : 'mouseenter focus';

  delegate(document.body, {
    target: TOOLTIP_SELECTOR,
    allowHTML: false,
    animation: 'fade',
    arrow: false,
    placement: 'top',
    offset: [0, 8],
    maxWidth: 260,
    delay: useTouch ? [0, 0] : [200, 0],
    hideOnClick: true,
    interactive: false,
    appendTo: () => document.body,
    theme: 'pels',
    trigger,
    onShow(instance) {
      const content = getTooltipContent(instance.reference);
      if (!content) return false;
      hideAll({ exclude: instance });
      instance.setContent(content);
      return undefined;
    },
  });
};
