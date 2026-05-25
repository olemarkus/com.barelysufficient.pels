import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- *
 * style.css token-audit regression (TODO ~line 2437).
 *
 * Before this audit `public/style.css` carried a long tail of hardcoded
 * geometric (px) and typographic (rem) literals for properties that the
 * design-token layer covers — `gap`, `padding`, `margin`, `border-radius`,
 * `font-size`. The bare literals included:
 *   - `gap: 12px` (multiple sites)         → --spacing-3
 *   - `padding: 12px` in `.price-summary`  → --spacing-3
 *   - `margin: 4px` in card/hero h2 + device-detail h2 → --spacing-1
 *   - `border-radius: 8px` in `.price-summary` (drifted 2 px below the
 *      sibling `.price-notice-info` / `.price-notice-warning` cards' 10 px
 *      `--radius-md`)                       → --radius-md
 *   - `border-radius: 999px` on pill primitives (visually identical to
 *      `--radius-full` = 9999 px, but parallel literal)
 *   - `font-size: 0.62rem` on `.plan-card__metric-scale` endpoint labels
 *      (no existing token covered the ~10 px sub-caption size)
 *
 * The audit:
 *   1. Bound every literal with an existing token at the same resolved
 *      value (12px → --spacing-3, 8px → --spacing-2, 4px → --spacing-1,
 *      16px → --spacing-4, 24px → --spacing-6, 999px → --radius-full).
 *   2. Introduced ONE new token, `--font-size-xxs: 10px`
 *      (in `tokens/base.json`), and bound `.plan-card__metric-scale` to it.
 *   3. Normalized `.price-summary` corner shape to `--radius-md` to bring
 *      it into the same card family as `.price-notice-info` /
 *      `.price-notice-warning` (both already on `--radius-md`).
 *
 * This test locks the key call-site bindings (the offenders the TODO
 * explicitly catalogued) so a future edit cannot silently re-introduce a
 * bare literal there.
 *
 * Intermediate values (gap: 2px / 6px / 10px and similar small paddings)
 * remain literal — they fall between existing spacing-scale steps and
 * inventing `--spacing-0_5` / `--spacing-1_5` / `--spacing-2_5` for them
 * would create awkward fractional tokens that fight the existing numeric
 * convention. The "border-radius: 50%" circle shapes and "border-radius: 0"
 * reset are intentional geometric primitives, not px literals.
 * -------------------------------------------------------------------------- */

const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const TOKENS_CSS_PATH = path.join(__dirname, '..', 'dist', 'tokens.css');

function ruleFor(selector: string): string {
  const styleCss = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`, 'u');
  const match = styleCss.match(pattern);
  return match?.[0] ?? '';
}

describe('style.css token audit (TODO ~line 2437)', () => {
  describe('new token: --font-size-xxs', () => {
    it('is declared in the generated tokens.css at 10px', () => {
      const tokensCss = fs.readFileSync(TOKENS_CSS_PATH, 'utf8');
      expect(tokensCss).toMatch(/--font-size-xxs:\s*10px\s*[;/]/);
    });

    it('powers .plan-card__metric-scale font-size in public/style.css', () => {
      const rule = ruleFor('.plan-card__metric-scale');
      expect(rule).not.toBe('');
      expect(rule).toMatch(/font-size:\s*var\(--font-size-xxs\)\s*;/);
      // Defensive: ensure the prior bare `0.62rem` literal is gone.
      expect(rule).not.toMatch(/font-size:\s*0\.62rem/);
    });
  });

  describe('.price-summary card family normalization', () => {
    it('binds padding + margin to --spacing-3 and radius to --radius-md', () => {
      const rule = ruleFor('.price-summary');
      expect(rule).not.toBe('');
      expect(rule).toMatch(/padding:\s*var\(--spacing-3\)\s*;/);
      expect(rule).toMatch(/margin-bottom:\s*var\(--spacing-3\)\s*;/);
      expect(rule).toMatch(/border-radius:\s*var\(--radius-md\)\s*;/);
      // Defensive: prior literal `8px` corner radius (a 2 px drift below the
      // sibling notices' `--radius-md`) must not regress.
      expect(rule).not.toMatch(/border-radius:\s*8px/);
      expect(rule).not.toMatch(/padding:\s*12px/);
    });
  });

  describe('pill primitives → --radius-full', () => {
    it('removes every bare `border-radius: 999px` literal', () => {
      const styleCss = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
      expect(styleCss).not.toMatch(/border-radius:\s*999px/);
    });
  });

  describe('catalogued spacing bindings', () => {
    it('binds .form__actions gap to --spacing-3 (was `gap: 12px`)', () => {
      const rule = ruleFor('.form__actions');
      expect(rule).toMatch(/gap:\s*var\(--spacing-3\)\s*;/);
      expect(rule).not.toMatch(/gap:\s*12px/);
    });

    it('binds .card h2 / .pels-hero h2 margin to --spacing-1 (was `margin: 4px 0 0`)', () => {
      const styleCss = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
      // The combined selector ".card h2, .pels-hero h2" — match the joint rule.
      const match = styleCss.match(
        /\.card h2,\s*\.pels-hero h2\s*\{[^}]*\}/u,
      );
      expect(match).not.toBeNull();
      expect(match?.[0] ?? '').toMatch(
        /margin:\s*var\(--spacing-1\)\s+0\s+0\s*;/,
      );
    });
  });

  describe('no bare cleanly-bindable single-value literals remain', () => {
    /*
     * Guard against re-introducing the easy bindings: a fresh
     * `padding: 16px;` or `gap: 12px;` declaration would silently slip past
     * code review. The negative lookahead skips multi-value shorthands
     * (`padding: 2px 6px`) which legitimately keep intermediate-value
     * literals where the existing token scale does not cover them — those
     * are out of scope for this audit. Values 4/8/12/16/24/32 px all map
     * 1:1 to --spacing-{1,2,3,4,6,8}; any new bare occurrence indicates
     * regression.
     */
    it.each([
      ['gap', '4px', '--spacing-1'],
      ['gap', '8px', '--spacing-2'],
      ['gap', '12px', '--spacing-3'],
      ['gap', '16px', '--spacing-4'],
      ['gap', '24px', '--spacing-6'],
      ['gap', '32px', '--spacing-8'],
      ['padding', '4px', '--spacing-1'],
      ['padding', '8px', '--spacing-2'],
      ['padding', '12px', '--spacing-3'],
      ['padding', '16px', '--spacing-4'],
      ['padding', '24px', '--spacing-6'],
      ['padding', '32px', '--spacing-8'],
    ])(
      'no bare `%s: %s;` (should bind to %s)',
      (property, literal) => {
        const styleCss = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
        const pattern = new RegExp(
          `${property}:\\s*${literal.replace('.', '\\.')}\\s*;`,
          'gu',
        );
        const matches = styleCss.match(pattern) ?? [];
        expect(matches).toEqual([]);
      },
    );

    it('no bare `border-radius: 8px;` (should bind to --radius-md)', () => {
      const styleCss = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
      expect(styleCss).not.toMatch(/border-radius:\s*8px\s*;/);
    });

    it('no bare `font-size: <rem|px-numeric>` declarations', () => {
      const styleCss = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
      // `font-size: 1em` etc. would not match — only bare px / rem literals.
      const offending = styleCss.match(/font-size:\s*[0-9][0-9.]*(?:px|rem)\s*;/gu);
      expect(offending).toBeNull();
    });
  });
});
