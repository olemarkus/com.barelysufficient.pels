// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsUiPlanPayload } from '../../contracts/src/settingsUiApi.ts';
import { state } from '../src/ui/state.ts';

const getApiReadModelMock = vi.fn<() => Promise<SettingsUiPlanPayload>>();

vi.mock('../src/ui/homey.ts', () => ({
  getApiReadModel: () => getApiReadModelMock(),
}));

const { renderDeviceDetailLiveStatus } = await import('../src/ui/deviceDetail/liveStatus.ts');

const installHero = () => {
  document.body.innerHTML = `
    <div id="device-detail-live-status" hidden>
      <span id="device-detail-live-state"></span>
      <span id="device-detail-live-power"></span>
      <span id="device-detail-live-fact" hidden></span>
      <span id="device-detail-live-reason" hidden></span>
      <span id="device-detail-live-chip-row" hidden></span>
      <a id="device-detail-live-smart-task" hidden></a>
    </div>
  `;
};

const planWithReason = (reason: { code: 'cooldown_restore'; remainingSec: number }
  | { code: 'waiting_for_other_devices' }): SettingsUiPlanPayload => ({
  plan: {
    generatedAtMs: Date.now(),
    devices: [{
      id: 'charger',
      name: 'Charger',
      currentState: 'on',
      plannedState: 'keep',
      currentDrawKw: 1.2,
      reportedStepId: 'low',
      selectedStepId: 'medium',
      steppedLoad: {
        profile: {
          steps: [{ id: 'step_0', planningPowerW: 0 }, { id: 'low', planningPowerW: 1_000 }],
        },
        reportedStepId: 'low',
        targetStepId: 'medium',
        commandPending: false,
      },
      reason,
    }],
  },
} as SettingsUiPlanPayload);

describe('device-detail live status restore waits', () => {
  beforeEach(() => {
    installHero();
    state.dryRun = false;
    getApiReadModelMock.mockReset();
  });

  it('shows an active stepped device waiting to increase during its cooldown', async () => {
    getApiReadModelMock.mockResolvedValue(planWithReason({
      code: 'cooldown_restore',
      remainingSec: 18,
    }));

    await renderDeviceDetailLiveStatus('charger');

    expect(document.getElementById('device-detail-live-reason')?.textContent)
      .toBe('Waiting to increase — 18s');
  });

  it('shows an active stepped device queued behind another device', async () => {
    const payload = planWithReason({ code: 'waiting_for_other_devices' });
    const device = payload.plan?.devices?.[0];
    if (device) device.currentState = 'not_applicable';
    getApiReadModelMock.mockResolvedValue(payload);

    await renderDeviceDetailLiveStatus('charger');

    expect(document.getElementById('device-detail-live-reason')?.textContent)
      .toBe('Waiting to increase — other devices are ahead');
  });

  it('hides a retained action-wait reason when the device is unavailable', async () => {
    const payload = planWithReason({ code: 'cooldown_restore', remainingSec: 18 });
    const device = payload.plan?.devices?.[0];
    if (device) device.stateKind = 'unavailable';
    getApiReadModelMock.mockResolvedValue(payload);

    await renderDeviceDetailLiveStatus('charger');

    expect(document.getElementById('device-detail-live-state')?.textContent).toBe('Unavailable');
    expect(document.getElementById('device-detail-live-reason')?.hidden).toBe(true);
  });
});
