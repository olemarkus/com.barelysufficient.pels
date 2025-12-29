import type Homey from 'homey';
import type { DailyBudgetUiPayload } from './lib/dailyBudget/dailyBudgetTypes';

type ApiContext = {
  homey: Homey.App['homey'];
};

type DailyBudgetApp = Homey.App & {
  getDailyBudgetUiPayload?: () => DailyBudgetUiPayload | null;
};

const getApp = (homey: Homey.App['homey']): DailyBudgetApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as DailyBudgetApp;
};

export = {
  async get_daily_budget({ homey }: ApiContext): Promise<DailyBudgetUiPayload | null> {
    const app = getApp(homey);
    if (!app?.getDailyBudgetUiPayload) return null;
    try {
      return app.getDailyBudgetUiPayload();
    } catch (error) {
      app?.error?.('Daily budget API failed', error as Error);
      return null;
    }
  },
};
