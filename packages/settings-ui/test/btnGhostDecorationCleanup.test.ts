import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- *
 * `.btn` / `.btn ghost` / `.btn secondary` ghost-decoration cleanup
 * regression tests (batch 11, follow-up to PR #1036's native-button primitive
 * consolidation).
 *
 * Context: the legacy `.btn` shell + tonal modifiers (`ghost`, `secondary`,
 * `primary`, `confirming`) were applied as ghost companions on ~20 MD Web
 * button hosts. MD Web buttons render in shadow DOM and ignore host `color`
 * / `background` / `border` / `transform` / `box-shadow` declarations, so
 * the rules painted nothing the user could see. Only the `is-busy` rule
 * (host `cursor` + `opacity`) had measurable paint impact, since `opacity`
 * composites the entire host tree and `cursor` is a host-level pointer
 * affordance. This suite pins the surviving shape:
 *   - `.btn` / `.btn.ghost` / `.btn.secondary` / `.btn.primary` /
 *     `.btn.confirming` selectors are gone from style.css.
 *   - The surviving `.is-busy` rule still ships the `cursor: progress` +
 *     `opacity` contract that reaches the user through MD Web hosts.
 *   - No source file (HTML or TS/TSX) re-applies `.btn` as a primary class
 *     on a tappable button host. `is-busy` is allowed as a state class
 *     toggle in advanced.ts; the cleanup is about decoration, not state.
 *
 * Like sibling rebind suites, assertions are text-level checks so they
 * catch resurrection of the dropped vocabulary without coupling to pixel
 * output (the screenshot suite handles that).
 * -------------------------------------------------------------------------- */

const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const STYLE_CSS = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const SETTINGS_UI_SRC = path.join(__dirname, '..', 'src');

const collectSourceFiles = (dir: string, acc: string[] = []): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') return;
      collectSourceFiles(path.join(dir, entry.name), acc);
      return;
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      acc.push(path.join(dir, entry.name));
    }
  });
  return acc;
};

// Walk every CSS rule selector list (excluding at-rule preambles and pure
// whitespace chunks). Comments mentioning `.btn` for historical context
// are NOT counted -- the JS comment-strip below handles those.
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

const cssSelectorList = (): string[] => {
  const stripped = stripCssComments(STYLE_CSS);
  const selectors: string[] = [];
  const ruleRegex = /([^{}]*)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRegex.exec(stripped)) !== null) {
    const selectorChunk = match[1] ?? '';
    const trimmed = selectorChunk.trim();
    if (trimmed === '' || trimmed.startsWith('@')) continue;
    selectors.push(selectorChunk);
  }
  return selectors;
};

const ruleBodies = (selectorPattern: RegExp): string[] => {
  const stripped = stripCssComments(STYLE_CSS);
  const bodies: string[] = [];
  const ruleRegex = /([^{}]*)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRegex.exec(stripped)) !== null) {
    const selectors = match[1] ?? '';
    const body = match[2] ?? '';
    if (selectorPattern.test(selectors)) {
      bodies.push(body);
    }
  }
  return bodies;
};

describe('btn ghost-decoration cleanup: dead .btn CSS selectors are gone', () => {
  it('declares no .btn rule (bare class or with descendant/state) in style.css', () => {
    const offenders = cssSelectorList().filter((sel) => /(^|\s|>|,|:)\.btn(\b|[.:[])/.test(sel));
    expect(
      offenders,
      'unexpected .btn selector(s) survived the ghost-decoration cleanup:\n' + offenders.join('\n'),
    ).toHaveLength(0);
  });

  it('declares no .btn.ghost / .btn.secondary / .btn.primary / .btn.confirming rules', () => {
    const offenders = cssSelectorList().filter((sel) => (
      /\.btn\.ghost\b/.test(sel)
      || /\.btn\.secondary\b/.test(sel)
      || /\.btn\.primary\b/.test(sel)
      || /\.btn\.confirming\b/.test(sel)
    ));
    expect(
      offenders,
      'tonal .btn.* modifier selector(s) survived:\n' + offenders.join('\n'),
    ).toHaveLength(0);
  });
});

describe('btn ghost-decoration cleanup: the is-busy paint contract still ships', () => {
  it('keeps an MD Web button .is-busy rule that ships cursor + opacity', () => {
    // The lone survivor of the cleanup. `cursor: progress` and `opacity:
    // 0.8` both reach the user even on MD Web button hosts because
    // `cursor` is a host-level pointer affordance and `opacity` composites
    // the whole host tree (shadow DOM included). advanced.ts uses this
    // rule via classList toggle on four MD Web buttons (clear device,
    // clear unknown, refresh api list, log api device). Scoped to the MD
    // Web button tags so a future `.is-busy` on a non-button element
    // doesn't inherit the busy affordance by accident.
    const bodies = ruleBodies(/md-(outlined|text|filled)-button\.is-busy\b/);
    const hasBusyContract = bodies.some((body) => (
      /cursor:\s*progress/.test(body) && /opacity:\s*0\.8/.test(body)
    ));
    expect(
      hasBusyContract,
      'expected an md-*-button.is-busy rule with cursor: progress + opacity: 0.8',
    ).toBe(true);
  });
});

describe('btn ghost-decoration cleanup: no consumer re-applies .btn as a primary class', () => {
  it('no tappable element in index.html carries btn / btn ghost / btn secondary / btn primary tokens', () => {
    // Walk every class="..." attribute literal and reject any that lists
    // `btn` as a token. `is-busy` is intentionally NOT in this rejection
    // set: it's a state class toggled at runtime by advanced.ts and the
    // cleanup deliberately preserves it as the surviving paint contract.
    const lines = INDEX_HTML.split('\n');
    const offenders = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /class="[^"]*\bbtn\b[^"]*"/.test(line))
      .map(({ line, i }) => 'index.html:' + (i + 1) + ': ' + line.trim());
    expect(
      offenders,
      'unexpected .btn class token(s) in index.html:\n' + offenders.join('\n'),
    ).toHaveLength(0);
  });

  it('no .tsx source file re-applies btn / btn ghost / btn secondary / btn primary tokens', () => {
    // Same logic as the HTML walk, against every TS/TSX file in src/. The
    // four call sites we cleaned up (ElectricityPricesView, PriceAware
    // DevicesView, BudgetOverview, plus the back-button header copies)
    // should no longer carry the legacy classes.
    const sourceFiles = collectSourceFiles(SETTINGS_UI_SRC);
    const offenders: string[] = [];
    sourceFiles.forEach((file) => {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (/class(Name)?="[^"]*\bbtn\b[^"]*"/.test(line)) {
          offenders.push(file + ':' + (i + 1) + ': ' + line.trim());
        }
      });
    });
    expect(
      offenders,
      'unexpected .btn class token(s) in src/:\n' + offenders.join('\n'),
    ).toHaveLength(0);
  });
});
