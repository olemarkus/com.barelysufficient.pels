import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- *
 * Building-plan chip pulse — CSS contract regression.
 *
 * The Smart-tasks list and the deadline-plan pending hero both render the
 * "Building plan…" chip via the canonical `.plan-chip` primitive. While the
 * planner is still working (waiting on price publishes / device samples) the
 * chip opts into a low-key opacity loop so users have a liveness signal —
 * without the pulse the chip is static text that reads identically whether
 * planning just started or has been stuck for two minutes.
 *
 * This test pins three contracts that span the CSS file:
 *   1. A `.plan-chip[data-pulse="true"]` rule binds the pulse animation,
 *      gated behind `prefers-reduced-motion: no-preference` so it never
 *      paints for users who opted out of motion.
 *   2. The keyframes (`plan-chip-building-pulse`) match the design spec
 *      `0% / 50% / 100% = 1 / 0.6 / 1` — subtle enough to read as
 *      breathing without stealing attention from actionable content.
 *   3. A `prefers-reduced-motion: reduce` block explicitly sets
 *      `animation: none` for `.plan-chip[data-pulse="true"]` so the chip
 *      stays still under the reduced-motion preference (mirrors the
 *      `.plan-card__stepped-seg[data-pulse="true"]` reduced-motion fallback).
 * -------------------------------------------------------------------------- */

const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const STYLE_CSS = fs.readFileSync(STYLE_CSS_PATH, 'utf8');

describe('building-plan chip pulse (CSS contract)', () => {
  it('binds the .plan-chip[data-pulse="true"] animation behind prefers-reduced-motion: no-preference', () => {
    // Single regex spans `@media (prefers-reduced-motion: no-preference) { …
    // .plan-chip[data-pulse="true"] { animation: plan-chip-building-pulse
    // var(--pels-motion-pulse-duration) … } }` — guards both the gate AND the
    // bound keyframe + token in one assertion so a partial regression cannot
    // pass (e.g. removing only the @media wrapper or only the token reference).
    expect(STYLE_CSS).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{[^}]*\.plan-chip\[data-pulse="true"\]\s*\{[^}]*animation:\s*plan-chip-building-pulse\s+var\(--pels-motion-pulse-duration\)\s+ease-in-out\s+infinite[^}]*\}/u,
    );
  });

  it('declares the plan-chip-building-pulse keyframes as a subtle 1 → 0.6 → 1 opacity loop', () => {
    // The keyframe body is the visual spec — opacity-only (no transform, no
    // scale) so the chip reads as breathing rather than wobbling, and the
    // 0.6 floor matches the `plan-stepped-direction-pulse` floor (the other
    // "actively working" planner motion) instead of going as deep as the
    // 0.45 `plan-stepped-pulse` floor (used for the more dramatic
    // capacity-stepped indicator). Locks the floor + the 0% / 50% / 100%
    // shape so any future tuning has to update this test deliberately.
    expect(STYLE_CSS).toMatch(
      /@keyframes\s+plan-chip-building-pulse\s*\{\s*0%,\s*100%\s*\{\s*opacity:\s*1\s*;?\s*\}\s*50%\s*\{\s*opacity:\s*0\.6\s*;?\s*\}\s*\}/u,
    );
  });

  it('disables the pulse under prefers-reduced-motion: reduce', () => {
    // Accessibility floor — the reduce branch must explicitly null out the
    // animation so the chip stays still for users who opted out of motion.
    // Mirrors the `.plan-card__stepped-seg[data-pulse="true"]` reduced-motion
    // fallback that ships in the same file.
    expect(STYLE_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.plan-chip\[data-pulse="true"\]\s*\{[^}]*animation:\s*none[^}]*\}/u,
    );
  });
});
