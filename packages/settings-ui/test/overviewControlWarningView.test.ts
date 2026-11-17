import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { OverviewControlWarningIcon } from '../src/ui/views/OverviewControlWarning.tsx';
import { resolveControlContestRecommendations } from '../src/ui/recommendationsModel.ts';
import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import type { SettingsUiDeviceListItem } from '../src/ui/deviceUtils.ts';
import { PlanGenericCard, PlanTemperatureCard } from '../src/ui/views/PlanDeviceCards.tsx';
import { PlanSteppedCard } from '../src/ui/views/PlanSteppedCard.tsx';
import { uiDeviceFixture } from './helpers/deviceStatusFixture.ts';

const mount = document.createElement('div');
const [recommendation] = resolveControlContestRecommendations([withDescriptorIdentity<SettingsUiDeviceListItem>({
  id: 'heater', name: 'Hall heater', managed: true, available: true, targets: [],
  expectedPowerKw: 1, expectedPowerSource: 'default',
  controlContest: { setting: 'temperature', commanded: 22, observed: 28, count: 4, sinceMs: 1000 },
})]);

let showDialog: MockInstance;
beforeEach(() => {
  // jsdom has no native dialog.showModal. The dialog mounts under the body, so
  // it is connected and would call it; the test follows the open state instead.
  showDialog = vi.spyOn(customElements.get('md-dialog')!.prototype, 'show').mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => render(null, mount));
  showDialog.mockRestore();
});

describe('Overview warning icon', () => {
  it.each(['generic', 'temperature', 'stepped'])('appears on a %s device card', (kind) => {
    const props = {
      dev: uiDeviceFixture({ id: 'heater', name: 'Hall heater' }),
      dryRun: false, nowMs: 1000, warning: { recommendation },
    };
    act(() => render(kind === 'generic'
      ? h(PlanGenericCard, { ...props, evStateLine: null })
      : kind === 'temperature' ? h(PlanTemperatureCard, props) : h(PlanSteppedCard, props), mount));
    expect(mount.querySelector('.plan-card .plan-card__control-warning-icon')).not.toBeNull();
  });

  const dialogButton = (label: string) => (
    [...document.querySelectorAll('md-dialog md-text-button')].find((button) => button.textContent === label)
  );
  const openDialog = (): void => {
    act(() => { mount.querySelector('md-icon-button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };

  it('opens its explanation and hides the warning without activating the device card', async () => {
    const activate = vi.fn();
    const dismiss = vi.fn().mockResolvedValue(undefined);
    act(() => render(h('div', { onClick: activate, onKeyDown: activate, onKeyUp: activate },
      h(OverviewControlWarningIcon, { warning: { recommendation, onDismiss: dismiss } })), mount));
    const icon = mount.querySelector('md-icon-button')!;
    expect(icon.querySelector('svg')).not.toBeNull();
    expect(mount.querySelector('.plan-chip')).toBeNull();
    openDialog();
    const dialog = document.querySelector('md-dialog')!;
    expect(dialog.textContent).toContain('22 °C');
    expect(dialog.textContent).toContain('Hide warning removes this icon until it happens again.');
    const hideButton = dialogButton('Hide warning')!;
    await act(async () => {
      hideButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      hideButton.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
      hideButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(dismiss).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    // The owner, not a resolved callback, removes a successfully acknowledged icon.
    expect(mount.querySelector('md-icon-button')).not.toBeNull();
  });

  it('mounts the dialog under the body with two actions and a close icon', () => {
    act(() => render(h(OverviewControlWarningIcon, { warning: { recommendation } }), mount));
    openDialog();
    const dialog = document.querySelector('md-dialog')!;
    // Outside the card, so its scrim dims every card and not only the ones before it.
    expect(dialog.parentElement).toBe(document.body);
    expect(mount.contains(dialog)).toBe(false);
    expect([...dialog.querySelectorAll('md-text-button')].map((button) => button.textContent))
      .toEqual(['Hide warning', 'Open device']);
    const close = dialog.querySelector('[slot="headline"] md-icon-button[aria-label="Close"]')!;
    act(() => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.querySelector('md-dialog')).toBeNull();
  });

  it('opens the device page at the notice', () => {
    const opened = vi.fn();
    document.addEventListener('open-device-detail', opened);
    try {
      act(() => render(h(OverviewControlWarningIcon, { warning: { recommendation } }), mount));
      openDialog();
      act(() => { dialogButton('Open device')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(opened).toHaveBeenCalledOnce();
      expect((opened.mock.calls[0]![0] as CustomEvent).detail)
        .toEqual({ deviceId: 'heater', focus: 'control-contest' });
      expect(document.querySelector('md-dialog')).toBeNull();
    } finally {
      document.removeEventListener('open-device-detail', opened);
    }
  });

  it('keeps an unavailable acknowledgement visible with Hide warning disabled', () => {
    act(() => render(h(OverviewControlWarningIcon, { warning: { recommendation } }), mount));
    openDialog();
    expect(dialogButton('Hide warning')?.hasAttribute('disabled')).toBe(true);
  });
});
