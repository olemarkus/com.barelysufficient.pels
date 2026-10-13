// Chart sizing for the widgets that draw an SVG at its measured CSS-pixel size
// (price, smart_tasks trajectory). Drawing the viewBox at the element's real
// size keeps chart text at the `--pw-*` token sizes at any tile width, instead
// of scaling a fixed viewBox onto the tile. Browser-safe: bundled into each
// widget's `public/index.js` IIFE.

export type BoxSize = { width: number; height: number };

// The element's laid-out size in whole CSS px, or `fallback` when there is no
// layout box yet (jsdom, a hidden view, pre-paint).
export const measureBox = (el: Element, fallback: BoxSize): BoxSize => {
  const rect = el.getBoundingClientRect();
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return fallback;
  return { width, height };
};

type ResizeWindow = Window & { ResizeObserver?: typeof globalThis.ResizeObserver };

// Call `onResize` when `el`'s size changes; returns the teardown. A no-op where
// the window has no ResizeObserver (jsdom/preview), which then keeps the size
// drawn at render time.
export const observeBox = (widgetWindow: ResizeWindow, el: Element, onResize: () => void): (() => void) => {
  if (typeof widgetWindow.ResizeObserver !== 'function') return () => {};
  const observer = new widgetWindow.ResizeObserver(() => onResize());
  observer.observe(el);
  return () => observer.disconnect();
};
