/**
 * "Deliver [N] kWh to [device] by [HH:mm]": the card that creates an energy
 * smart task. Beside the temperature and charging cards in `deadlineObjectiveCards.ts`,
 * which registers it; split out for the file cap.
 */
import {
  MAX_TARGET_ENERGY_KWH,
  MIN_TARGET_ENERGY_KWH,
} from '../packages/shared-domain/src/settings/deferredObjectiveSettings';
import { supportsEnergyObjective } from './smartTaskDeviceCapability';
import { registerSetDeadlineCard, validateNumberInRange } from './deadlineCardWrites';
import type { FlowCardDeps } from './registerFlowCards';

export function registerSetEnergyDeadlineCard(deps: FlowCardDeps): void {
  registerSetDeadlineCard(
    deps,
    'set_energy_deadline',
    'Device must be provided.',
    supportsEnergyObjective,
    (label) => `'${label}' is not an on/off device with a live power reading, `
      + 'so PELS cannot count the energy it takes.',
    (args: { target_kwh?: unknown } | null) => {
      const targetEnergyKWh = validateNumberInRange(
        args?.target_kwh,
        'Energy (kWh)',
        MIN_TARGET_ENERGY_KWH,
        MAX_TARGET_ENERGY_KWH,
      );
      // Re-running the card for the deadline already set keeps the energy fed so
      // far (the delivery count is keyed by device and deadline); a new deadline
      // starts a new count.
      return (deadlineAtMs) => ({ enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh, deadlineAtMs });
    },
  );
}
