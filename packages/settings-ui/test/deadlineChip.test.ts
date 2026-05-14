import { h, render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { DeadlineChip } from '../src/ui/views/PlanDeviceCards.tsx';
import { state } from '../src/ui/state.ts';
import { createEmptyDeferredObjectiveSettings } from '../../contracts/src/deferredObjectiveSettings.ts';

const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

const renderChip = (deviceId: string, nowMs: number = NOW_MS): HTMLDivElement => {
  const mount = document.createElement('div');
  render(h(DeadlineChip, { deviceId, nowMs }), mount);
  return mount;
};

const futureDeadline = (): number => NOW_MS + 6 * 60 * 60 * 1000;
const pastDeadline = (): number => NOW_MS - 60 * 1000;

afterEach(() => {
  state.deferredObjectiveSettings = createEmptyDeferredObjectiveSettings();
});

describe('DeadlineChip', () => {
  it('renders nothing when the device has no objective entry', () => {
    const mount = renderChip('device-without-deadline');
    expect(mount.querySelector('a')).toBeNull();
  });

  it('renders a link to the deadline page when an entry exists', () => {
    state.deferredObjectiveSettings = {
      version: 1,
      objectivesByDeviceId: {
        'connected-300': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 65,
          deadlineAtMs: futureDeadline(),
        },
      },
    };

    const link = renderChip('connected-300').querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('Smart task');
    expect(link?.getAttribute('href')).toBe('./?page=deadline-plan&deviceId=connected-300');
    expect(link?.classList.contains('plan-chip--link')).toBe(true);
  });

  it('renders nothing when the entry exists but is disabled', () => {
    state.deferredObjectiveSettings = {
      version: 1,
      objectivesByDeviceId: {
        'connected-300': {
          enabled: false,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 65,
          deadlineAtMs: futureDeadline(),
        },
      },
    };

    expect(renderChip('connected-300').querySelector('a')).toBeNull();
  });

  it('does not render when the deadline has already passed', () => {
    state.deferredObjectiveSettings = {
      version: 1,
      objectivesByDeviceId: {
        'connected-300': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 65,
          deadlineAtMs: pastDeadline(),
        },
      },
    };

    expect(renderChip('connected-300').querySelector('a')).toBeNull();
  });

  describe('with the chip mounted inside a parent card', () => {
    const seedEnabledObjective = (): void => {
      state.deferredObjectiveSettings = {
        version: 1,
        objectivesByDeviceId: {
          'connected-300': {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 65,
            deadlineAtMs: futureDeadline(),
          },
        },
      };
    };

    const mountChipInCard = () => {
      const card = document.createElement('article');
      const counts = { click: 0, keydown: 0, keyup: 0 };
      card.addEventListener('click', () => { counts.click += 1; });
      card.addEventListener('keydown', () => { counts.keydown += 1; });
      card.addEventListener('keyup', () => { counts.keyup += 1; });
      const inner = document.createElement('div');
      card.appendChild(inner);
      document.body.appendChild(card);
      render(h(DeadlineChip, { deviceId: 'connected-300', nowMs: NOW_MS }), inner);
      const link = card.querySelector('a') as HTMLAnchorElement;
      // Suppress real navigation in jsdom.
      link.addEventListener('click', (event) => event.preventDefault());
      return { card, link, counts };
    };

    afterEach(() => {
      while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    });

    it('stops click propagation so the surrounding card does not also activate', () => {
      seedEnabledObjective();
      const { link, counts } = mountChipInCard();
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(counts.click).toBe(0);
    });

    it('stops Enter keydown propagation so the parent card does not open device detail', () => {
      seedEnabledObjective();
      const { link, counts } = mountChipInCard();
      link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(counts.keydown).toBe(0);
    });

    it('treats Space as activation: prevents scroll on keydown, navigates on keyup, never fires the parent', () => {
      seedEnabledObjective();
      const { link, counts } = mountChipInCard();
      let navigated = 0;
      link.addEventListener('click', () => { navigated += 1; });

      const keydown = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      link.dispatchEvent(keydown);
      expect(keydown.defaultPrevented).toBe(true);
      expect(counts.keydown).toBe(0);

      const keyup = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
      link.dispatchEvent(keyup);
      expect(counts.keyup).toBe(0);
      expect(navigated).toBe(1);
    });
  });
});
