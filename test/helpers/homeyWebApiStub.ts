import type { HomeyWebApiGet } from '../../lib/price/homeyPriceFormula';
import { HOMEY_PRICE_FORMULA } from '../../lib/utils/settingsKeys';
import type { HomeyEnergyApi } from '../../lib/utils/homeyEnergy';
import { HomeyHttpStatusError } from '../../lib/utils/homeyHttpStatusError';

/**
 * A Homey Web API read that answers everything with `null`.
 *
 * For the price-formula route that means "the owner has configured no formula",
 * so prices stay exactly as the spec fed them in. This is the neutral default
 * for the many price specs that predate the formula; specs about the formula
 * itself serve their own answers.
 */
export const noHomeyWebApi: HomeyWebApiGet = async () => null;

/**
 * Mirror what Homey reports for a home whose owner has configured no price
 * formula, so the raw prices a spec feeds in are the prices it gets back.
 *
 * A spec that drives the Homey scheme without ever reading the formula has a
 * home whose pricing is UNKNOWN, and PELS publishes no prices there rather than
 * passing wholesale spot off as the owner's price. Specs about something else
 * — slot rotation, price levels, currency — say so with this.
 */
export const mirrorNoHomeyPriceFormula = (settings: { set(key: string, value: unknown): void }): void => {
  settings.set(HOMEY_PRICE_FORMULA, { mathExpression: null });
};

/**
 * Homey Energy with no prices for any date, for price specs that do not drive
 * the Homey scheme's day-ahead prices. Homey answers such a date with HTTP 500
 * `NotFoundError`, so this rejects the same way.
 */
export const noHomeyEnergyPrices: HomeyEnergyApi = {
  fetchDynamicElectricityPrices: async () => {
    throw new HomeyHttpStatusError(500, '{"error":"NotFoundError","error_description":"NotFoundError"}');
  },
};
