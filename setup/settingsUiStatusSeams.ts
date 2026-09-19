/**
 * The status seams the running app exposes to the settings UI, shape-guarded
 * once.
 *
 * `AppContext` declares each of these required, so the real app always has
 * them — but `homey.app` is typed as the SDK's base `App`, so their presence is
 * still a runtime question at the read site. These guards answer it here, at
 * the boundary, rather than letting an optional method and a nullable return
 * travel inward to the payload builders.
 *
 * They live together because they are the same boundary question asked about
 * different provenance: which forecast planning is using, and whether the
 * owner's Homey price setup can be read at all.
 */

import type {
  HomeyPriceFormulaUiStatus,
  PvForecastSourceUiStatus,
} from '../packages/contracts/src/settingsUiApi';

type PvForecastSourceSeam = { getPvForecastSourceUiStatus: () => PvForecastSourceUiStatus };

type HomeyPriceFormulaSeam = { getHomeyPriceFormulaUiStatus: () => HomeyPriceFormulaUiStatus };

export const hasPvForecastSourceSeam = (app: unknown): app is PvForecastSourceSeam => (
  typeof app === 'object'
  && app !== null
  && 'getPvForecastSourceUiStatus' in app
  && typeof app.getPvForecastSourceUiStatus === 'function'
);

export const hasHomeyPriceFormulaSeam = (app: unknown): app is HomeyPriceFormulaSeam => (
  typeof app === 'object'
  && app !== null
  && 'getHomeyPriceFormulaUiStatus' in app
  && typeof app.getHomeyPriceFormulaUiStatus === 'function'
);
