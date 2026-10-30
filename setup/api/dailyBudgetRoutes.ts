import {
  getBudgetDailyHistoryFromHomey,
  getBudgetDecisionHistoryFromHomey,
} from '../../lib/weather/budgetDiagnosticsApi';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetUiRead,
} from '../../packages/contracts/src/dailyBudgetTypes';
import {
  applySettingsUiDailyBudgetModel,
  getSettingsUiDailyBudget,
  getSettingsUiWeatherAdvisorReadout,
  previewSettingsUiDailyBudgetModel,
} from '../settingsUiApi';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const dailyBudgetRoutes = defineRoutes({
  get_daily_budget: ({ homey }: ApiContext): DailyBudgetUiRead => getSettingsUiDailyBudget({ homey }),
  ui_preview_daily_budget_model: (
    { homey, body }: ApiContext & { body?: unknown },
  ): DailyBudgetModelPreviewResponse => previewSettingsUiDailyBudgetModel({ homey, body }),
  ui_apply_daily_budget_model: (
    { homey, body }: ApiContext & { body?: unknown },
  ): DailyBudgetUiRead => applySettingsUiDailyBudgetModel({ homey, body }),
  ui_weather_advisor_readout: ({ homey }: ApiContext) => getSettingsUiWeatherAdvisorReadout({ homey }),
  diagnostics_budget_days: ({ homey, query }: ApiContext & { query?: unknown }) => (
    getBudgetDailyHistoryFromHomey(homey, query)
  ),
  diagnostics_budget_decisions: ({ homey, query }: ApiContext & { query?: unknown }) => (
    getBudgetDecisionHistoryFromHomey(homey, query)
  ),
});
