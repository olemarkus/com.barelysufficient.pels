/**
 * The two limit fields, read back as numbers.
 *
 * Neither read ever answers "no limit". The heating field has always resolved
 * an unparseable value to the saved limit, else a default, and the cooling
 * field does the same: every setpoint entry the editor writes carries both
 * limits, so the runtime never asks whether one is configured.
 */
import { deviceDetailShedCoolingTemp, deviceDetailShedTemp } from '../dom.ts';
import { state } from '../state.ts';
import { COOLING_SHED_DEFAULT_C } from '../../../../shared-domain/src/utils/airtreatmentConstants.ts';

export const parseShedTemperatureInput = (): number | null => {
  const parsedTemp = Number.parseFloat(deviceDetailShedTemp?.value || '');
  if (!Number.isFinite(parsedTemp)) return null;
  if (parsedTemp < -20 || parsedTemp > 50) return null;
  return parsedTemp;
};

/**
 * The bounds match the field's own: a ceiling below any real cooling setpoint
 * would make limiting add load, which is the outcome the whole second limit
 * exists to prevent.
 */
const parseCoolingShedTemperatureInput = (): number | null => {
  const parsedTemp = Number.parseFloat(deviceDetailShedCoolingTemp?.value || '');
  if (!Number.isFinite(parsedTemp)) return null;
  if (parsedTemp < 16 || parsedTemp > 40) return null;
  return parsedTemp;
};

/** The cooling limit the device's entry carries now — the saved one, else the default. */
export const savedCoolingShedTemperature = (deviceId: string): number => (
  state.shedBehaviors[deviceId]?.coolingTemperature ?? COOLING_SHED_DEFAULT_C
);

/**
 * The cooling limit to persist, read from its field. Only for a device that can
 * say it is cooling: the field is hidden otherwise, and a hidden field's value
 * is not the owner's choice. A field that did not parse is written back with
 * the value the entry will carry, as the heating field is.
 */
export const resolveCoolingShedTemperature = (deviceId: string): number => {
  const parsed = parseCoolingShedTemperatureInput();
  const resolved = parsed ?? savedCoolingShedTemperature(deviceId);
  if (parsed === null && deviceDetailShedCoolingTemp) deviceDetailShedCoolingTemp.value = resolved.toString();
  return resolved;
};
