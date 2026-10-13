import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { DeadlineChip } from '../src/ui/views/PlanDeviceCards.tsx';
import { appendDeviceStateChips } from '../src/ui/deviceListPresentation.ts';
import type { SettingsUiDeviceListItem } from '../src/ui/deviceUtils.ts';
import { state } from '../src/ui/state.ts';
import { createEmptyDeferredObjectiveSettings } from '../../shared-domain/src/settings/deferredObjectiveSettings.ts';
import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import { styleRule } from './helpers/primitiveStyles.ts';

afterEach(() => {
  state.deferredObjectiveSettings = createEmptyDeferredObjectiveSettings();
});

describe('chip primitive', () => {
  it.each(['good', 'warn', 'alert', 'info', 'muted', 'limited'])(
    'shares the %s tone between modifier and data-attribute consumers',
    (tone) => {
      const modifier = styleRule(`.plan-chip--${tone}`);
      expect(modifier).not.toBe('');
      expect(styleRule(`.plan-chip[data-tone="${tone}"]`)).toBe(modifier);
    },
  );

  it('makes tooltip help discoverable', () => {
    expect(styleRule('.plan-chip[data-tooltip]')).toMatch(/cursor:\s*help/);
  });

  it.each(['usage-hero-delta', 'usage-day-status-pill'])('%s uses a muted chip', (id) => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const chip = new DOMParser().parseFromString(html, 'text/html').getElementById(id);
    expect(chip?.classList.contains('plan-chip')).toBe(true);
    expect(chip?.classList.contains('plan-chip--muted')).toBe(true);
  });

  it('uses the informational link chip for a smart task', () => {
    const nowMs = Date.UTC(2026, 4, 24, 12);
    state.deferredObjectiveSettings = {
      version: 1,
      objectivesByDeviceId: {
        'connected-300': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 65,
          deadlineAtMs: nowMs + 6 * 3_600_000,
        },
      },
    };
    const mount = document.createElement('div');
    render(h(DeadlineChip, { deviceId: 'connected-300', nowMs }), mount);
    const link = mount.querySelector('a.plan-chip.plan-chip--info.plan-chip--link');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('data-tooltip')).toBe('Open smart task');
  });

  it('uses a muted chip for an unavailable device', () => {
    const mount = document.createElement('div');
    const device = withDescriptorIdentity<SettingsUiDeviceListItem>({
      id: 'unavailable', name: 'Unavailable Device', available: false, targets: [],
      expectedPowerKw: 1, expectedPowerSource: 'default',
    });
    appendDeviceStateChips(mount, device);
    const chip = mount.querySelector<HTMLElement>('.device-row__state-chip.plan-chip.plan-chip--muted');
    expect(chip?.textContent).toBe('Unavailable');
    expect(chip?.dataset.tone).toBe('muted');
  });
});
