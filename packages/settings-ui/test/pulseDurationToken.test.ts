import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- *
 * Pulse-duration token consolidation regression.
 *
 * Before this refactor `public/style.css` carried three near-identical
 * literal durations for its pulse animations:
 *   - `.device-loading-notice`                       → 1.5s
 *   - `.plan-card__stepped-direction`                → 1.6s
 *   - `.plan-card__stepped-seg[data-pulse="true"]`   → 1.4s
 *
 * The three values are perceptually indistinguishable, so they were
 * collapsed to a single canonical 1.5s (median) cadence exposed via the
 * `--pels-motion-pulse-duration` token in `tokens/component.json`. This
 * test locks the contract end-to-end so future edits cannot silently drift
 * the cadence apart again:
 *   1. `tokens.css` declares `--pels-motion-pulse-duration: 1.5s` (style-
 *      dictionary output from `tokens/component.json`).
 *   2. Every pulse-using `animation:` declaration in `public/style.css`
 *      consumes `var(--pels-motion-pulse-duration)` — one declaration per
 *      keyframe (`pulse`, `plan-stepped-direction-pulse`,
 *      `plan-stepped-pulse`).
 *   3. The previous bare-literal durations (1.4s / 1.5s / 1.6s) no longer
 *      appear on any pulse `animation:` line.
 *
 * The keyframe definitions themselves are intentionally NOT collapsed —
 * they encode meaningfully different visual effects (transform translateY
 * for the directional indicator vs. opacity-only for the loading notice
 * and stepped segment, plus distinct opacity floors of 0.6 vs. 0.45). The
 * TODO ask was about the duration literals, not the keyframe content.
 * -------------------------------------------------------------------------- */

const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const TOKENS_CSS_PATH = path.join(__dirname, '..', 'dist', 'tokens.css');

const EXPECTED_PULSE_KEYFRAMES: ReadonlyArray<string> = [
  'pulse',
  'plan-stepped-direction-pulse',
  'plan-stepped-pulse',
];

describe('pulse duration token (--pels-motion-pulse-duration)', () => {
  it('is declared in the generated tokens.css with the canonical 1.5s median', () => {
    const tokensCss = fs.readFileSync(TOKENS_CSS_PATH, 'utf8');
    expect(tokensCss).toMatch(
      /--pels-motion-pulse-duration:\s*1\.5s\s*;/,
    );
  });

  it.each(EXPECTED_PULSE_KEYFRAMES)(
    'routes the %s animation through var(--pels-motion-pulse-duration)',
    (keyframe) => {
      const styleCss = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
      const expectedAnimation = new RegExp(
        `animation:\\s*${keyframe}\\s+var\\(--pels-motion-pulse-duration\\)\\s+ease-in-out\\s+infinite\\s*;`,
        'u',
      );
      expect(styleCss).toMatch(expectedAnimation);
    },
  );

  it('removes all bare 1.4s / 1.5s / 1.6s literals from pulse animation lines', () => {
    const styleCss = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
    const pulseAnimationLines = styleCss
      .split('\n')
      .filter((line) => /\banimation:\s*[a-z-]*pulse\b/iu.test(line));
    // Exactly three call sites — one per keyframe — and all routed through
    // the token. This guards against both new untracked pulse animations
    // and any regression that re-inlines a bare duration literal.
    expect(pulseAnimationLines).toHaveLength(EXPECTED_PULSE_KEYFRAMES.length);
    for (const line of pulseAnimationLines) {
      expect(line).toMatch(/var\(--pels-motion-pulse-duration\)/);
      expect(line).not.toMatch(/\s1\.[456]s/);
    }
  });
});
