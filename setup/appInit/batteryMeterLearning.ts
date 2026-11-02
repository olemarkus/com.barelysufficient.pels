import type { AppContext } from '../../lib/app/appContext';
import { BatteryDemandForecaster } from '../../lib/battery/batteryDemandForecast';
import { acceptBatteryEfficiencyCyclesRow, BatteryEfficiencyLearner } from '../../lib/battery/batteryEfficiencyLearner';
import { BatteryMeterLearning } from '../../lib/battery/batteryMeterLearning';
import type { BatteryEfficiencyStore } from '../../lib/ports/batteryEfficiencyStore';
import { createJsonRowTable } from '../../lib/store/jsonRowTable';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';

/**
 * The battery owner's measured efficiency cycles on the app's userdata
 * database: one row per battery, written only when a cycle is accepted.
 * Learned data lives there by ruling (`notes/settings-key-ownership.md`
 * § "Which store a key lives in"). lib/battery cannot reach lib/store, so the
 * table is built here, with the battery owner's own rule for which rows it
 * would have written. The table is taken on each call, on the database open
 * now: the learner reads once and writes only when a cycle is accepted, and
 * nothing at construction needs the database.
 */
export const createBatteryEfficiencyStoreForApp = (
  ctx: Pick<AppContext, 'getUserdataDatabase'>,
): BatteryEfficiencyStore => {
  const table = () => createJsonRowTable<readonly number[]>(
    ctx.getUserdataDatabase(), 'battery_efficiency_cycles', ['device_id', 'cycles_json'],
    acceptBatteryEfficiencyCyclesRow,
  );
  return {
    read: () => {
      const batteries = table();
      return ctx.getUserdataDatabase().transaction(() => batteries.read());
    },
    write: (cycles) => {
      const batteries = table();
      ctx.getUserdataDatabase().transaction(() => batteries.write(cycles));
    },
  };
};

/**
 * The Main meter's battery learning, over the Main home's devices
 * (`getMainDevices`, the app's Main-home filter). Constructed with the app; reads are lazy.
 */
export const createBatteryMeterLearningForApp = (
  ctx: Pick<AppContext, 'getTimeZone' | 'batterySolarScope' | 'hasEnabledContinuousBatteryPlan'
    | 'getUserdataDatabase'>,
  getMainDevices: () => DeviceSurfaces[],
): BatteryMeterLearning => new BatteryMeterLearning(
  new BatteryDemandForecaster(getMainDevices, () => ctx.getTimeZone(), ctx.batterySolarScope,
    () => ctx.hasEnabledContinuousBatteryPlan()),
  new BatteryEfficiencyLearner(createBatteryEfficiencyStoreForApp(ctx), getMainDevices),
);
