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
};

/**
 * Register the shared `[hidden]`-guard suite for one widget stylesheet.
 *
 * Requires the blanket `[hidden] { display: none !important }` reset that
 * protects every hidden element, regardless of its class.
 */
export const registerHiddenGuardSuite = (options: HiddenGuardSuiteOptions): void => {
  const { name, cssRelativePath } = options;

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
  });
};

/** The widget stylesheet at `cssRelativePath` (repo-root relative), parsed. */
export const readCssRuleBlocks = (cssRelativePath: string): CssRuleBlock[] => (
  parseCssRuleBlocks(readFileSync(resolve(process.cwd(), cssRelativePath), 'utf8'))
);

/**
 * The value the LAST rule targeting `sel` (as a complete selector member, not
 * a descendant) gives `property`, or undefined when no rule sets it. Last wins,
 * as in the cascade for equal-specificity rules.
 */
export const declaredValue = (
  ruleBlocks: readonly CssRuleBlock[],
  sel: string,
  property: string,
): string | undefined => {
  const pattern = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`);
  let value: string | undefined;
  for (const block of ruleBlocks) {
    if (!block.selectors.split(',').some((member) => member.trim() === sel)) continue;
    const match = pattern.exec(block.body);
    if (match) value = match[1].trim();
  }
  return value;
};

export type FixedHeightFrameOptions = {
  /** Suite name passed to `describe`. */
  name: string;
  /** Widget directory under `widgets/`, e.g. `price`. */
  widget: string;
};

/**
 * Register the fixed-height frame contract for one widget: the manifest sets
 * the same aspect-ratio height as the Budget and Price widget, the shipped
 * page fills the iframe (no body padding, root pinned to 100%), and the root
 * never grows past the frame. Reads the BUILT `public/` files, so a stale
 * `npm run build:widgets` fails here.
 */
export const registerFixedHeightFrameSuite = ({ name, widget }: FixedHeightFrameOptions): void => {
  describe(name, () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), `widgets/${widget}/widget.compose.json`), 'utf8'),
    ) as { height?: unknown };
    const html = readFileSync(resolve(process.cwd(), `widgets/${widget}/public/index.html`), 'utf8');
    const ruleBlocks = readCssRuleBlocks(`widgets/${widget}/public/index.css`);

    test('the manifest height is the Budget and Price aspect ratio', () => {
      expect(manifest.height).toBe('100%');
    });

    test('the page fills the iframe and the root is pinned to it', () => {
      expect(html).toMatch(/<body class="homey-widget-full">/);
      expect(declaredValue(ruleBlocks, 'body', 'overflow')).toBe('hidden');
      expect(declaredValue(ruleBlocks, 'body', 'height')).toBe('100%');
      expect(declaredValue(ruleBlocks, '.widget-root', 'height')).toBe('100%');
      expect(declaredValue(ruleBlocks, '.widget-root', 'display')).toBe('flex');
      expect(declaredValue(ruleBlocks, '.widget-root', 'box-sizing')).toBe('border-box');
    });
  });
};
