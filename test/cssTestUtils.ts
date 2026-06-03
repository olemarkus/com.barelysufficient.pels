import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// Shared CSS-parsing + `[hidden]`-guard assertions for the widget browser
// suites. Each widget's `index.css` is toggled view-by-view via the `hidden`
// attribute by its renderer; any author-origin `display` rule on a
// hidden-toggled element would beat the user-agent `[hidden] { display: none }`
// rule on cascade origin (regardless of specificity), so the hidden element
// would still render. The guard the suites pin is a single blanket
// author-origin reset, `[hidden] { display: none !important }`, which
// re-asserts the UA semantics for EVERY hidden-toggled element at once.
//
// jsdom does not model author-over-UA origin precedence, so a
// getComputedStyle assertion cannot distinguish the bug from the fix; the
// suites instead pin the source guard that prevents it.

export type CssRuleBlock = {
  selectors: string;
  body: string;
};

/**
 * Parse a stylesheet into `selector { declarations }` rule blocks.
 *
 * Strips `/* … *\/` comments first: explanatory comments in these stylesheets
 * (and in the tests' own fixtures) contain literal `[hidden] { display: none }`
 * examples whose braces would otherwise corrupt the naive rule-block split.
 */
export const parseCssRuleBlocks = (css: string): CssRuleBlock[] => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return Array.from(withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({
    selectors: m[1].trim(),
    body: m[2],
  }));
};

/** True when a declaration body sets the `display` property at all. */
export const setsDisplay = (body: string): boolean => /(^|;|\{|\s)display\s*:/.test(body);

/** True when `selectors` targets `sel` (e.g. `.list-view`) as a complete class token. */
export const targetsSelector = (selectors: string, sel: string): boolean => (
  new RegExp(`(^|[\\s,>+~])${sel.replace('.', '\\.')}(?![\\w-])`).test(selectors)
);

/**
 * True when a rule block sets `display` on a hidden-toggled selector without a
 * `:not([hidden])` self-guard — i.e. it would still render while hidden.
 */
export const isUnguardedDisplayRule = (
  block: CssRuleBlock,
  hiddenToggledSelectors: readonly string[],
): boolean => {
  if (!setsDisplay(block.body)) return false;
  // Split a grouped selector list (`.a:not([hidden]), .b`) and check each member
  // on its own: a `.includes()` test on the whole string would let a guarded
  // sibling (`.a:not([hidden])`) mask an unguarded one (`.b`). Matchers stay
  // aligned to the only forms the renderers emit — `.x` and `.x:not([hidden])` —
  // rather than broadening for selector shapes the codebase never generates.
  const members = block.selectors.split(',').map((member) => member.trim());
  return hiddenToggledSelectors.some((sel) => {
    const guarded = `${sel}:not([hidden])`;
    return members.some((member) => targetsSelector(member, sel) && member !== guarded);
  });
};

/**
 * Find the first rule block whose selector list contains `sel` as a complete
 * class token (so `.summary` matches `.summary` and `.summary:empty` but not a
 * `.summary-foo` neighbour). Returns `undefined` when no block targets it.
 */
export const findRuleBlock = (
  ruleBlocks: readonly CssRuleBlock[],
  sel: string,
): CssRuleBlock | undefined => ruleBlocks.find(
  (b) => b.selectors.split(',').some((member) => targetsSelector(member.trim(), sel)),
);

/** Find the blanket `[hidden]` reset rule that also sets `display`, if present. */
export const findBlanketHiddenReset = (
  ruleBlocks: readonly CssRuleBlock[],
): CssRuleBlock | undefined => ruleBlocks.find(
  (b) => b.selectors === '[hidden]' && setsDisplay(b.body),
);

export type HiddenGuardSuiteOptions = {
  /** Suite name passed to `describe`. */
  name: string;
  /** Path to the widget stylesheet, relative to the vitest cwd (repo root). */
  cssRelativePath: string;
  /**
   * Every element the renderer toggles `hidden` on, keyed by the class CSS
   * targets it with. Each must end up `display:none` while hidden.
   */
  hiddenToggledSelectors: readonly string[];
};

/**
 * Register the shared `[hidden]`-guard suite for one widget stylesheet.
 *
 * Asserts (1) a blanket `[hidden] { display: none !important }` reset exists,
 * and (2) — as belt-and-suspenders should that reset ever be removed — that no
 * unguarded `display` rule targets a hidden-toggled selector without a
 * `:not([hidden])` self-guard.
 */
export const registerHiddenGuardSuite = (options: HiddenGuardSuiteOptions): void => {
  const { name, cssRelativePath, hiddenToggledSelectors } = options;

  describe(name, () => {
    // Resolve from the repo root (vitest cwd); import.meta.url is an http URL
    // under jsdom, so fileURLToPath is unavailable here.
    const css = readFileSync(resolve(process.cwd(), cssRelativePath), 'utf8');
    const ruleBlocks = parseCssRuleBlocks(css);
    const blanketReset = findBlanketHiddenReset(ruleBlocks);

    test('a blanket [hidden] reset re-asserts display:none for every hidden-toggled element', () => {
      // The single guard that covers every hidden-toggled element in one place.
      // Must be `!important` to win against author `display` rules on the same
      // element regardless of source order — author-vs-author ties break on
      // specificity/order, and `[hidden]` is lower-specificity than the class
      // rules it must override.
      expect(blanketReset).toBeDefined();
      expect(blanketReset!.body).toMatch(/display\s*:\s*none\s*!important/);
    });

    test('every hidden-toggled element is kept inert while hidden', () => {
      // Belt-and-suspenders: even if the blanket reset above were ever removed,
      // any `display` rule on a hidden-toggled selector must self-guard with
      // `:not([hidden])`. With the blanket reset present, this passes trivially
      // (the reset covers everything); without it, an unguarded `display` rule
      // on a hidden-toggled selector fails.
      if (blanketReset) return; // covered by the reset; nothing more to prove
      const unguarded = ruleBlocks.filter(
        (b) => isUnguardedDisplayRule(b, hiddenToggledSelectors),
      );
      expect(unguarded).toEqual([]);
    });
  });
};
