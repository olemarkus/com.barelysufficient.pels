// DOM helpers the widget renderers share. Browser-safe: bundled into each
// widget's `public/index.js` IIFE, like `widgetRuntime.ts` beside it.

export const clearChildren = (node: Node): void => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

/* eslint-disable no-param-reassign --
   The DOM-write helpers below take an element as a write sink; mutating its
   text/visibility is the helper's whole job. */

// Show `el` with `text`, or hide it when `text` is null/blank.
export const setLine = (el: HTMLElement, text: string | null): void => {
  const visible = Boolean(text && text.trim());
  el.textContent = visible ? text : '';
  el.hidden = !visible;
};

export const hide = (el: HTMLElement): void => { el.hidden = true; };

export const setVisible = (el: HTMLElement, visible: boolean): void => { el.hidden = !visible; };

/* eslint-enable no-param-reassign */

// The `data-*` value `key` on the nearest `selector` ancestor of a click target.
export const closestDataValue = (target: Element, selector: string, key: string): string | null => {
  const el = target.closest(selector);
  return el instanceof HTMLElement ? el.dataset[key] ?? null : null;
};
