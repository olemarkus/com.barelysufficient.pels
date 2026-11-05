import type { CurtailmentPotentialRead } from './curtailmentSurplus';
import type { PvForecastSourceId, SelectedPvForecast } from './pvForecastSource';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';

// The estimator reads the potential on every 10 s pipeline tick, but each tick
// also feeds the PV forecast a sample, which invalidates its fit memo — an
// unmemoized read would re-fit over the whole 90-day history every tick (hot-path
// CPU on a cpuwarn-sensitive Homey). The potential only moves on the hourly
// irradiance grid / 3-hourly refresh / slow fit drift, so a short TTL loses
// nothing. Dogfood-tunable.
// The memo is keyed on the SELECTED SOURCE as well as the hour: the owner can
// flip `pv_forecast_source` mid-hour, and the settings handler rebuilds prices
// and the plan straight away. Keyed on the hour alone, a switch away from a
// positive learned forecast would keep authorizing curtailment-based load from
// the source that is no longer selected for the rest of the TTL. Reading the
// selection to check the key is cheap — `getSelectedPvForecast()` only builds
// closures and tests `hasUsefulForecast`; the expensive `forecast()` /
// `getConfidence()` calls stay behind the memo.
const POTENTIAL_MEMO_TTL_MS = 30_000;

// Nothing memoized yet is a state of the memo, not a missing entry: `empty` is
// a member of the memo's own type so the hit test reads one discriminant and
// never a presence check.
type PotentialMemo =
  | { kind: 'empty' }
  | {
    kind: 'cached';
    hourStartMs: number;
    atMs: number;
    sourceId: PvForecastSourceId;
    value: CurtailmentPotentialRead;
  };

export function createCurtailmentPotentialRead(
  getSelectedPvForecast: () => SelectedPvForecast,
): { getPotential: (hourStartMs: number) => CurtailmentPotentialRead } {
  let potentialMemo: PotentialMemo = { kind: 'empty' };
  const resolvePotential = (
    selected: SelectedPvForecast,
    hourStartMs: number,
  ): CurtailmentPotentialRead => {
    const kwh = selected.forecast([hourStartMs])[0]?.generationKwh;
    const confidence = selected.getConfidence();
    if (!isFiniteNumber(kwh) || confidence === 'none') return { kind: 'unresolvable' };
    return { kind: 'resolved', potential: { kw: kwh, confidence } };
  };
  return {
    // Forecast potential for a UTC hour-start: the 1-hour forecast kWh IS the
    // mean kW over that hour; the selected source's confidence rides along so
    // the estimator can resolve its discount. `unresolvable` (fail-closed) when
    // the selected source reports no confidence or skips the hour.
    getPotential: (hourStartMs: number): CurtailmentPotentialRead => {
      const nowMs = Date.now();
      const selected = getSelectedPvForecast();
      if (
        potentialMemo.kind === 'cached'
        && potentialMemo.hourStartMs === hourStartMs
        && potentialMemo.sourceId === selected.sourceId
        && nowMs - potentialMemo.atMs < POTENTIAL_MEMO_TTL_MS
      ) {
        return potentialMemo.value;
      }
      const value = resolvePotential(selected, hourStartMs);
      potentialMemo = {
        kind: 'cached', hourStartMs, atMs: nowMs, sourceId: selected.sourceId, value,
      };
      return value;
    },
  };
}
