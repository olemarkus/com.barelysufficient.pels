import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createToggleGroup } from '../src/ui/components.ts';
import { STYLE_CSS, styleRule } from './helpers/primitiveStyles.ts';

const indexDocument = (): Document => new DOMParser().parseFromString(
  fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'), 'text/html',
);

describe('segmented control primitive', () => {
  it('gives the group and options the shared touch-target floor', () => {
    for (const selector of [
      '.segmented',
      '.segmented button.segmented__option.segmented__option.segmented__option',
    ]) expect(styleRule(selector)).toContain('min-height: var(--pels-touch-target-min)');
  });

  it('builds labelled native buttons, reflects selection, and dispatches the chosen value', () => {
    const onSelect = vi.fn();
    const group = createToggleGroup([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ], 'Test toggle', onSelect);
    expect(group.element.matches('.segmented[role="group"][aria-label="Test toggle"]')).toBe(true);
    const buttons = group.element.querySelectorAll<HTMLButtonElement>('button.segmented__option');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-pressed')).toBe('false');
    }
    group.setActive('b');
    expect(Array.from(buttons, (button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    buttons[0]?.click();
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('exposes device-detail limiting choices as a radio group', () => {
    const group = indexDocument().querySelector('#device-detail-overshoot-segmented');
    expect(group?.matches('.segmented[role="radiogroup"]')).toBe(true);
  });
});

describe('decorative Material effects', () => {
  it('keeps static elevation hidden from assistive technology', () => {
    const effects = indexDocument().querySelectorAll('md-elevation');
    expect(effects.length).toBeGreaterThan(0);
    for (const effect of effects) {
      expect(effect.getAttribute('aria-hidden')).toBe('true');
      expect(effect.getAttributeNames()).toEqual(['aria-hidden']);
    }
  });

  it('uses shadow tokens for elevation, allowing small element contrast outlines', () => {
    const allowed = [
      /^none(?: !important)?$/,
      /^var\(--shadow-[a-z-]+\)/,
      /^inset\s+0\s+(?:0\s+0\s+)?1px\s+/,
      /^0\s+0\s+0\s+(?:0?\.5|1|2|3)px\s+/,
      /^0\s+0\s+4px\s+0\s+var\(/,
    ];
    const shadows = Array.from(STYLE_CSS.matchAll(/^\s*box-shadow:\s*(.+?);?\s*$/gm), (match) => match[1] ?? '');
    expect(shadows.filter((value) => !allowed.some((pattern) => pattern.test(value)))).toEqual([]);
  });
});
