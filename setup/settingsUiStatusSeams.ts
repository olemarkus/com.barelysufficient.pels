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
 * different provenance: which forecast planning is using, whether the owner's
 * Homey price setup can be read at all, and what the Power by the Hour app
 * answered when PELS last asked it for prices.
 */

import type {
  HomeyPriceFormulaUiStatus,
  PowerhourSourceUiStatus,
  PvForecastSourceUiStatus,
} from '../packages/contracts/src/settingsUiApi';

type PvForecastSourceSeam = { getPvForecastSourceUiStatus: () => PvForecastSourceUiStatus };

type HomeyPriceFormulaSeam = { getHomeyPriceFormulaUiStatus: () => HomeyPriceFormulaUiStatus };

type PowerhourSourceSeam = { getPowerhourSourceUiStatus: () => PowerhourSourceUiStatus };

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

export const hasPowerhourSourceSeam = (app: unknown): app is PowerhourSourceSeam => (
  typeof app === 'object'
  && app !== null
  && 'getPowerhourSourceUiStatus' in app
  && typeof app.getPowerhourSourceUiStatus === 'function'
);
