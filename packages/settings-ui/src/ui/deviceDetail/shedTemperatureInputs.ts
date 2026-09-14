/**
 * The two limit fields, read back as numbers.
 *
 * A field never answers "no limit". Text that is not a number in the limit's
 * range reads as the value the entry already carries, and the caller then shows
 * the field the value it saves, so what the owner sees is what is saved. The ranges are the
 * key owner's (`shared-domain/src/settings/shedBehaviors.ts`), so the editor
 * cannot save a limit the runtime would clamp to something else.
 */
import {
  COOLING_SHED_LIMIT_RANGE,
  type ConfiguredShedBehavior,
  type ShedLimitRange,
} from '../../../../shared-domain/src/settings/shedBehaviors.ts';
import { COOLING_SHED_DEFAULT_C } from '../../../../shared-domain/src/utils/airtreatmentConstants.ts';

type LimitField = { value: string };

export const readShedLimitField = (field: LimitField, range: ShedLimitRange, fallbackC: number): number => {
  const parsed = Number.parseFloat(field.value);
  return Number.isFinite(parsed) && parsed >= range.minC && parsed <= range.maxC ? parsed : fallbackC;
};

/** The cooling limit a saved entry carries: its own for a setpoint entry, else where a new one starts. */
export const savedCoolingShedTemperature = (saved: ConfiguredShedBehavior): number => (
  saved.action === 'set_temperature' ? saved.coolingTemperature : COOLING_SHED_DEFAULT_C
);

/** Read the cooling limit from its field. */
export const resolveCoolingShedTemperature = (field: LimitField, saved: ConfiguredShedBehavior): number => (
  readShedLimitField(field, COOLING_SHED_LIMIT_RANGE, savedCoolingShedTemperature(saved))
);
