import { logSettingsError } from './logging.ts';

// `showTab` only STARTS the target panel's async scope work (a Main-only deep
// link switches scope first, and the panel's activation hook re-reads the
// roster and re-renders), so the promised control can stay hidden for several
// frames after the click handler returns. Scrolling immediately would anchor
// against a hidden element and leave the user at the panel top, so poll
// visibility across frames, bounded so a typo'd selector or a removed control
// degrades to landing at the panel top instead of polling forever.
const SETTINGS_ANCHOR_SCROLL_FRAMES = 60;
export const scrollSettingsAnchorWhenVisible = (selector: string, isCurrent = () => true, attempt = 0): void => {
  if (!isCurrent()) return;
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch (error) {
    void logSettingsError('Invalid settings anchor selector', error, 'settingsAnchor');
    return;
  }
  // An anchor inside a collapsed section promises its content, so open it.
  const collapsed = element?.closest('details:not([open])');
  if (collapsed instanceof HTMLDetailsElement) collapsed.open = true;
  if (element instanceof HTMLElement && element.offsetParent !== null) {
    element.scrollIntoView({ block: 'center' });
    return;
  }
  if (attempt >= SETTINGS_ANCHOR_SCROLL_FRAMES) return;
  requestAnimationFrame(() => scrollSettingsAnchorWhenVisible(selector, isCurrent, attempt + 1));
};
