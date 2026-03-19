/* global module, require */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const COMBINED_PRICES_SETTING = 'combined_prices';

const {
  buildPlanPriceWidgetPayload,
  resolveWidgetTarget,
} = require('./planPriceWidgetPayload');

module.exports = {
  async getChart({ homey, query }) {
    const app = homey.app;
    const snapshot = typeof app?.getDailyBudgetUiPayload === 'function'
      ? app.getDailyBudgetUiPayload()
      : null;
    const combinedPrices = homey.settings.get(COMBINED_PRICES_SETTING) ?? null;

    return buildPlanPriceWidgetPayload({
      snapshot,
      combinedPrices,
      target: resolveWidgetTarget(query?.day),
    });
  },
};
