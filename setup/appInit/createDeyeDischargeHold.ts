import { buildDeyeDischargeLimitActuator } from './buildDeviceActuator';
import { DeyeDischargeHold } from '../../lib/executor/deyeDischargeHold';
import type { AppContext } from '../../lib/app/appContext';

export const createDeyeDischargeHold = (settings: AppContext['homey']['settings']): DeyeDischargeHold => (
  new DeyeDischargeHold(settings, buildDeyeDischargeLimitActuator())
);

export { bindMainDischargeHold, type MainDischargeHold } from '../../lib/executor/deyeDischargeHold';
