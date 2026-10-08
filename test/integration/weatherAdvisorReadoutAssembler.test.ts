import type { AppContext } from '../../lib/app/appContext';
import type { WeatherCollector } from '../../lib/weather/weatherCollector';
import {
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  WEATHER_ADVISOR_SETTINGS,
} from '../../lib/utils/settingsKeys';
import { assembleWeatherAdvisorReadout } from '../../setup/appInit/weatherAdvisorReadoutAssembler';
import { createHomeyMock } from '../helpers/appContextTestHelpers';
import { partialDouble } from '../helpers/partialDouble';

describe('assembleWeatherAdvisorReadout', () => {
  it('uses the daily-budget service as the single source for the active budget', async () => {
    const { appHomey, flowHomey } = createHomeyMock();
    flowHomey.settings.set(WEATHER_ADVISOR_SETTINGS, { enabled: true });
    // Simulate a settings write that the budget service has not loaded yet.
    flowHomey.settings.set(DAILY_BUDGET_ENABLED, false);
    flowHomey.settings.set(DAILY_BUDGET_KWH, 12);

    const context = partialDouble<Pick<
      AppContext,
      'homey' | 'getNow' | 'getTimeZone' | 'capacitySettings'
    >>({
      homey: appHomey,
      getNow: () => new Date('2026-09-28T12:00:00.000Z'),
      getTimeZone: () => 'UTC',
      capacitySettings: { capacityEnabled: true, gridImportLimitKw: null, limitKw: 12, marginKw: 0.5, periodMinutes: 60 },
    });
    const collector = partialDouble<WeatherCollector>({
      getHistoryStateSnapshot: () => ({ records: [] }),
      isBackfillRunning: () => false,
    });

    // The assembler reads the owner directly. It must not replace the applied
    // values with the stale persisted settings above.
    const dailyBudget = partialDouble<NonNullable<AppContext['dailyBudgetService']>>({
      getAppliedBudgetKwh: () => 42,
      isEnabled: () => true,
    });
    const readout = await assembleWeatherAdvisorReadout(context, collector, dailyBudget);

    expect(readout).toMatchObject({
      kind: 'readout',
      payload: { dailyBudgetKwh: 42, dailyBudgetEnabled: true },
    });
  });
});
