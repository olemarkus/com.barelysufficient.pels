import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// First-paint loading skeletons across the panels. Overview already wires
// the canonical `pels-skeleton-stack` primitive (verified at v2.7.3); this
// file extends the contract to Budget, Usage, and the Smart task SPA
// route so all panels share the same M3 shimmer placeholder instead of a
// flat grey wall while the bootstrap fetch resolves.
//
// Source-of-truth is the public `index.html` (not the synced `settings/`
// copy) because `npm run build:settings` regenerates the latter from the
// former.

const INDEX_HTML_PATH = path.resolve(
  __dirname,
  '..',
  'public',
  'index.html',
);

describe('panel loading skeletons (public/index.html)', () => {
  let document: Document;

  beforeAll(() => {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');
    document = new DOMParser().parseFromString(html, 'text/html');
  });

  // Canonical skeleton shape (matches the Overview hero in `#plan-hero`):
  // an `aria-busy="true"` container, a `.pels-skeleton-stack` of shimmer
  // placeholders (`aria-hidden="true"`), and a sibling `.visually-hidden`
  // span carrying the panel-specific SR copy. Each panel's test asserts the
  // SR text directly so a copy regression in one panel doesn't slip through.

  describe('Budget panel', () => {
    it('marks the Preact surface as aria-busy and mounts a skeleton stack so the panel never paints empty', () => {
      const surface = document.querySelector('#budget-redesign-surface');
      expect(surface).not.toBeNull();
      expect(surface?.getAttribute('aria-busy')).toBe('true');
      const skeleton = surface?.querySelector(':scope > .pels-skeleton-stack');
      expect(skeleton).not.toBeNull();
      // At least one `pels-skeleton` placeholder must be present so the
      // shimmer actually renders something; specific variants are an impl
      // detail.
      expect(skeleton?.querySelectorAll('.pels-skeleton').length).toBeGreaterThan(0);
    });

    it('carries panel-specific SR copy so users on screen readers know what is loading', () => {
      const srText = document
        .querySelector('#budget-redesign-surface > .visually-hidden');
      expect(srText?.textContent).toBe('Loading budget…');
    });
  });

  describe('Usage panel', () => {
    it('starts in data-loading="true" so CSS can hide the static placeholders behind the skeleton', () => {
      const panel = document.querySelector('#usage-panel');
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute('data-loading')).toBe('true');
    });

    it('carries a visually-hidden h2 panel landmark so SR heading nav matches the other panels', () => {
      // PR #881's hero trim demoted "Energy history" from an `<h2>` to a
      // `<p class="eyebrow">`, leaving the only remaining `<h2>` on the
      // panel as the dynamic value display (`-- kWh today`). Other panels
      // (Overview, Budget, Smart tasks, Settings) all carry a topical
      // `<h2>` at the panel level; restoring one as a `.visually-hidden`
      // child keeps the eyebrow as the lone visible label while putting a
      // stable landmark back into the document outline.
      const panel = document.querySelector('#usage-panel');
      const landmark = panel?.querySelector(':scope > h2.visually-hidden');
      expect(landmark).not.toBeNull();
      expect(landmark?.textContent?.trim()).toBe('Usage');
    });

    it('mounts a usage-loading-skeleton container as a direct usage child so it paints before the hero/cards', () => {
      const panel = document.querySelector('#usage-panel');
      const skeleton = panel?.querySelector(':scope > .usage-loading-skeleton');
      expect(skeleton).not.toBeNull();
      expect(skeleton?.getAttribute('aria-busy')).toBe('true');
      expect(skeleton?.querySelector('.pels-skeleton-stack')).not.toBeNull();
      expect(skeleton?.querySelectorAll('.pels-skeleton').length).toBeGreaterThan(0);
    });

    it('carries panel-specific SR copy', () => {
      const srText = document
        .querySelector('#usage-panel > .usage-loading-skeleton > .visually-hidden');
      expect(srText?.textContent).toBe('Loading usage…');
    });
  });

  describe('Smart task (deadline-plan-root)', () => {
    it('mounts a skeleton card inside the deadline-plan surface so the SPA route never paints a text-only loading title', () => {
      const root = document.querySelector('#deadline-plan-root');
      expect(root).not.toBeNull();
      const card = root?.querySelector('.pels-surface-card');
      expect(card?.getAttribute('aria-busy')).toBe('true');
      expect(card?.querySelector('.pels-skeleton-stack')).not.toBeNull();
      expect(card?.querySelectorAll('.pels-skeleton').length).toBeGreaterThan(0);
    });

    it('carries panel-specific SR copy', () => {
      const srText = document
        .querySelector('#deadline-plan-root .pels-surface-card > .visually-hidden');
      expect(srText?.textContent).toBe('Loading smart task…');
    });
  });
});
