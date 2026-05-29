import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('smart tasks widget hidden-element CSS', () => {
  // The renderer switches views (.list-view/.detail-view) and toggles the row
  // list (.rows) plus the empty/overflow/detail lines by setting the `hidden`
  // attribute. Any author-origin `display` rule on such an element would beat
  // the user-agent `[hidden] { display: none }` rule on cascade origin
  // (regardless of specificity), so a hidden view would still render — the list
  // and detail views stack on top of each other and the widget reads as frozen
  // / unresponsive to taps. The fix is a single blanket author-origin reset,
  // `[hidden] { display: none !important }`, which re-asserts the UA semantics
  // for EVERY hidden-toggled element at once.
  // jsdom does not model author-over-UA origin precedence, so a
  // getComputedStyle assertion cannot distinguish the bug from the fix; we
  // instead pin the source guard that prevents it.
  // Resolve from the repo root (vitest cwd); import.meta.url is an http URL
  // under jsdom, so fileURLToPath is unavailable here.
  const cssPath = resolve(process.cwd(), 'widgets/smart_tasks/public/index.css');
  // Strip `/* … */` comments first: the explanatory comments contain literal
  // `[hidden] { display: none }` examples whose braces would otherwise corrupt
  // the naive rule-block split below.
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  // Split into `selector { declarations }` rule blocks.
  const ruleBlocks = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({
    selectors: m[1].trim(),
    body: m[2],
  }));

  const setsDisplay = (body: string): boolean => /(^|;|\{|\s)display\s*:/.test(body);

  // Every element the renderer toggles `.hidden` on (render.ts), keyed by the
  // class CSS targets it with. Each must end up `display:none` while hidden.
  const hiddenToggledSelectors = [
    '.list-view', '.detail-view', // views
    '.rows', // row list (hidden when the payload is empty)
    '.empty', '.empty-hint', '.overflow', // list affordances
    '.detail-line', // toggled detail text lines
  ];

  const targetsSelector = (selectors: string, sel: string): boolean => (
    // The class appears as a complete token, not as a substring of another class.
    new RegExp(`(^|[\\s,>+~])${sel.replace('.', '\\.')}(?![\\w-])`).test(selectors)
  );

  const blanketReset = ruleBlocks.find(
    (b) => b.selectors === '[hidden]' && setsDisplay(b.body),
  );

  test('a blanket [hidden] reset re-asserts display:none for every hidden-toggled element', () => {
    // The single guard that covers both views, the row list, and any future
    // hidden-toggled element in one place. Must be `!important` to win against
    // author `display` rules on the same element regardless of source order —
    // author-vs-author ties break on specificity/order, and `[hidden]` is
    // lower-specificity than the class rules it must override.
    expect(blanketReset).toBeDefined();
    expect(blanketReset!.body).toMatch(/display\s*:\s*none\s*!important/);
  });

  test('every hidden-toggled element is kept inert while hidden', () => {
    // Belt-and-suspenders: even if the blanket reset above were ever removed,
    // any `display` rule on a hidden-toggled selector must self-guard with
    // `:not([hidden])`. With the blanket reset present, this passes trivially
    // (the reset covers everything); without it, an unguarded `display` rule on
    // a hidden-toggled selector — like the original .list-view/.detail-view bug
    // — fails.
    if (blanketReset) return; // covered by the reset; nothing more to prove
    const unguarded = ruleBlocks
      .filter((b) => setsDisplay(b.body))
      .filter((b) => hiddenToggledSelectors.some((sel) => (
        targetsSelector(b.selectors, sel) && !b.selectors.includes(`${sel}:not([hidden])`)
      )));
    expect(unguarded).toEqual([]);
  });
});
