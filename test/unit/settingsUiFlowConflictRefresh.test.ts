import { refreshSettingsUiFlowConflictPayload } from '../../lib/flowApi/settingsUiFlowConflictRefresh';
import type { PowerUsageFlowReporters } from '../../lib/flowApi/userFlows';
import type { ConfiguredPowerSourceRead } from '../../lib/ports/configuredPowerSource';

const refresh = (
  powerUsageReporters: PowerUsageFlowReporters,
  powerSource: ConfiguredPowerSourceRead,
) => refreshSettingsUiFlowConflictPayload({
  requestRefresh: async () => ({
    state: 'resolved',
    flowFacts: { writes: new Map(), evSocReporters: [], powerUsageReporters, steppedLoadCards: {} },
  }),
  readDevices: () => [],
  readPowerSource: () => powerSource,
});

describe('refreshSettingsUiFlowConflictPayload ignored power reporting', () => {
  it('names the Flow whose Report power usage readings PELS ignores under Power meter', async () => {
    const payload = await refresh(
      { flowCount: 1, flowName: 'Strømforbruk' },
      { state: 'resolved', value: 'homey_energy' },
    );

    expect(payload.ignoredPowerUsageFlows).toEqual({ state: 'present', flowCount: 1, flowName: 'Strømforbruk' });
  });

  it('claims nothing when Flow card is the power source, so the Flow is in use', async () => {
    const payload = await refresh({ flowCount: 2 }, { state: 'resolved', value: 'flow' });

    expect(payload.ignoredPowerUsageFlows).toEqual({ state: 'none' });
  });

  it('claims nothing when the power source could not be read', async () => {
    const payload = await refresh(
      { flowCount: 1, flowName: 'Strømforbruk' },
      { state: 'suspect', reason: 'read_failed', error: new Error('settings unavailable') },
    );

    expect(payload.ignoredPowerUsageFlows).toEqual({ state: 'none' });
  });
});
