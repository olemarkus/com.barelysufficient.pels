import { delegate, hideAll, type Instance, type Props } from 'tippy.js';

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

// Exported so controls that NAVIGATE on tap (e.g. the device-list detail
// button) can skip attaching a tooltip on touch: with the touch `click`
// trigger, a single tap would both navigate AND open the tooltip, which then
// floats stranded over the new view with nothing left to dismiss it. Keep the
// `aria-label` on such controls — only the visual tooltip is suppressed.
export const prefersTouch = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(hover: none), (pointer: coarse)').matches;
};

const showTooltip = (instance: Instance): false | undefined => {
  const content = getTooltipContent(instance.reference);
  if (!content) return false;
  hideAll({ exclude: instance });
  const reference = instance.reference as HTMLElement;
  if (!reference.dataset.tooltipGuide) {
    instance.setContent(content);
    return undefined;
  }
  const guide = document.createElement('div');
  guide.className = 'pels-tooltip-guide';
  const text = document.createElement('p');
  text.textContent = content;
  const link = document.createElement('a');
  link.href = reference.dataset.tooltipGuide;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = reference.dataset.tooltipGuideLabel ?? 'Read the guide';
  link.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    reference.focus();
    if (event.shiftKey) event.preventDefault();
    else instance.hide();
  });
  guide.append(text, link);
  instance.setContent(guide);
  return undefined;
};

export const initTooltips = (): void => {
  if (typeof document === 'undefined' || !document.body) return;

  const useTouch = prefersTouch();
  const trigger = useTouch ? 'click' : 'mouseenter focus';

  const options: Partial<Props> = {
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
    onShow: showTooltip,
  };
  delegate(document.body, {
    ...options,
    target: `${TOOLTIP_SELECTOR}:not([data-tooltip-guide])`,
  });
  delegate(document.body, {
    ...options,
    target: `${TOOLTIP_SELECTOR}[data-tooltip-guide]`,
    interactive: true,
    trigger: useTouch ? 'click' : 'mouseenter focus click',
    onCreate: (instance) => {
      instance.reference.addEventListener('keydown', (event) => {
        if (!(event instanceof KeyboardEvent) || event.key !== 'Tab'
          || event.shiftKey || !instance.state.isVisible) return;
        const link = instance.popper.querySelector('a');
        if (!link) return;
        event.preventDefault();
        link.focus();
      });
    },
  });
};
