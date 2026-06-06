import type { DevicePlanDevice, EvKind, PlanInputDevice } from './planTypes';
import { getLogger } from '../logging/logger';
import { resolveBoostActive } from '../device/deviceActionProjection';
import { isEvPlanDevice } from './planEvDevice';

// `resolveEvBoostActive` moved to `lib/device/deviceActionProjection.ts`
// as chunk 1 of the planner-detype refactor. Re-exported here so every
// existing call site continues to work unchanged.
export { resolveEvBoostActive } from '../device/deviceActionProjection';

const logger = getLogger('plan/ev-boost');

export function emitEvBoostStateChange(params: {
  dev: PlanInputDevice;
  previousActive: boolean;
  active: boolean;
}): void {
  const { dev, previousActive, active } = params;
  if (previousActive === active) return;
  // EV-boost state only transitions for EV devices, so the cluster reads are
  // gated on the EV narrowing. A non-EV device never has EV fields set, so the
  // null fallbacks below are equivalent — but the guard keeps the reads sound
  // against the EV-omitted base.
  const ev = isEvPlanDevice(dev) ? dev : null;
  const stateOfCharge = ev?.stateOfCharge;
  const boostBelowPercent = ev?.evBoost?.boostBelowPercent;
  logger.debug({
    event: 'ev_boost_state_changed',
    deviceId: dev.id,
    deviceName: dev.name,
    active,
    previousActive,
    percent: typeof stateOfCharge?.percent === 'number' ? stateOfCharge.percent : null,
    boostBelowPercent: typeof boostBelowPercent === 'number' ? boostBelowPercent : null,
    status: stateOfCharge?.status ?? null,
    evChargingState: ev?.evChargingState ?? null,
    observationStale: dev.observationStale === true,
  });
}

export function buildBoostPlanDeviceFields(params: {
  dev: PlanInputDevice;
  temperatureBoostActive: boolean;
  evBoostActive: boolean;
}): Pick<
  DevicePlanDevice,
  | 'currentTemperature'
  | 'temperatureBoost'
  | 'temperatureBoostActive'
  | 'boostActive'
> & EvKind {
  const { dev, temperatureBoostActive, evBoostActive } = params;
  // The EV cluster (`evBoost`, `stateOfCharge`) is sourced only from EV
  // devices; gate the reads on the EV narrowing. `evBoostActive` is resolved by
  // the caller and carried regardless (it is `false` for non-EV devices). The
  // returned `EvKind` is regrouped onto the variant by `withEvDiscriminant` at
  // the construction site.
  const ev = isEvPlanDevice(dev) ? dev : null;
  return {
    currentTemperature: dev.currentTemperature,
    temperatureBoost: dev.temperatureBoost,
    temperatureBoostActive,
    boostActive: resolveBoostActive({ temperatureBoostActive, evBoostActive }),
    evBoost: ev?.evBoost,
    evBoostActive,
    stateOfCharge: ev?.stateOfCharge,
  };
}
