import { createTemperatureSetpointResolver } from '../../lib/thermostat/temperatureSetpoints';
import type { ResolveTemperatureSetpoints } from '../../packages/planner-types/src/temperatureSetpoints';
import type { PlanEngineWiring } from './planEngineWiring';

/**
 * Bind `lib/thermostat`'s setpoint resolver to one home's reads, for that home's
 * plan builder. Construction only: each read is the home's own member, passed
 * through unchanged, and no value is looked at here.
 *
 * A file of its own for one reason: the setup-boundary check budgets how many
 * domain peers each wiring file names, and `createPlanEngine.ts` is at its
 * budget. Naming `lib/thermostat` here keeps that file's count where it was.
 */
export const bindTemperatureSetpoints = (wiring: PlanEngineWiring): ResolveTemperatureSetpoints => (
  createTemperatureSetpointResolver({
    getOperatingMode: wiring.getOperatingMode,
    getModeDeviceTargets: wiring.getModeDeviceTargets,
    getPriceOptimizationEnabled: wiring.getPriceOptimizationEnabled,
    getPriceOptimizationSettings: wiring.getPriceOptimizationSettings,
    getCurrentHourPriceLevel: wiring.getCurrentHourPriceLevel,
    shouldApplyPriceShift: wiring.shouldApplyPriceShift,
    hasPendingPriceShiftCancellations: wiring.hasPendingPriceShiftCancellations,
    getThermalDirection: wiring.getThermalDirection,
    getShedBehavior: wiring.getShedBehavior,
  })
);
