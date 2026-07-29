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

  // Canonical visible skeleton shape matches the Overview hero in `#plan-hero`.

  describe('Budget panel', () => {
    it('mounts a skeleton stack so the panel never paints empty', () => {
      const surface = document.querySelector('#budget-redesign-surface');
      expect(surface).not.toBeNull();
      const skeleton = surface?.querySelector(':scope > .pels-skeleton-stack');
      expect(skeleton).not.toBeNull();
      // At least one `pels-skeleton` placeholder must be present so the
      // shimmer actually renders something; specific variants are an impl
      // detail.
      expect(skeleton?.querySelectorAll('.pels-skeleton').length).toBeGreaterThan(0);
    });
  });

  describe('Usage panel', () => {
    it('starts in data-loading="true" so CSS can hide the static placeholders behind the skeleton', () => {
      const panel = document.querySelector('#usage-panel');
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute('data-loading')).toBe('true');
    });

    it('mounts a usage-loading-skeleton container as a direct usage child so it paints before the hero/cards', () => {
      const panel = document.querySelector('#usage-panel');
      const skeleton = panel?.querySelector(':scope > .usage-loading-skeleton');
      expect(skeleton).not.toBeNull();
      expect(skeleton?.querySelector('.pels-skeleton-stack')).not.toBeNull();
      expect(skeleton?.querySelectorAll('.pels-skeleton').length).toBeGreaterThan(0);
    });
  });

  describe('Smart task (deadline-plan-root)', () => {
    it('mounts a skeleton card inside the deadline-plan surface so the SPA route never paints a text-only loading title', () => {
      const root = document.querySelector('#deadline-plan-root');
      expect(root).not.toBeNull();
      const card = root?.querySelector('.pels-surface-card');
      expect(card?.querySelector('.pels-skeleton-stack')).not.toBeNull();
      expect(card?.querySelectorAll('.pels-skeleton').length).toBeGreaterThan(0);
    });
  });
});
