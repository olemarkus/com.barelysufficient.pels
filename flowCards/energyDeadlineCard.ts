/**
 * "Deliver [N] kWh to [device] by [HH:mm]": the card that creates an energy
 * smart task. Beside the temperature and charging cards in `deadlineObjectiveCards.ts`,
 * which registers it; split out for the file cap.
 */
import type { DeferredObjectiveSettingsEntry } from '../lib/objectives/deferredObjectives';
import {
  MAX_TARGET_ENERGY_KWH,
  MIN_TARGET_ENERGY_KWH,
} from '../packages/shared-domain/src/settings/deferredObjectiveSettings';
import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';
import { supportsEnergyObjective } from './smartTaskDeviceCapability';
import {
  isOfferedDevice,
  resolveReadyByToDeadlineAtMs,
  throwIfWriteRefused,
  validateNumberInRange,
  validateReadyBy,
} from './deadlineCardWrites';
import type { FlowCardDeps } from './registerFlowCards';

export function registerSetEnergyDeadlineCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard('set_energy_deadline');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as {
      device?: RawFlowDeviceArg;
      target_kwh?: unknown;
      ready_by?: unknown;
    } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) throw new Error('Device must be provided.');
    const snapshot = await deps.getSnapshot();
    const device = snapshot.find((entry) => entry.id === deviceId);
    if (!device) throw new Error(`Device '${deviceId}' was not found.`);
    if (!supportsEnergyObjective(device)) {
      throw new Error(`'${device.name.trim() || deviceId}' is not an on/off device with a live power reading, `
        + 'so PELS cannot count the energy it takes.');
    }
    const targetEnergyKWh = validateNumberInRange(
      payload?.target_kwh,
      'Energy (kWh)',
      MIN_TARGET_ENERGY_KWH,
      MAX_TARGET_ENERGY_KWH,
    );
    const deadlineLocalTime = validateReadyBy(payload?.ready_by);
    const deadlineAtMs = resolveReadyByToDeadlineAtMs(deps, deadlineLocalTime);
    const entry: DeferredObjectiveSettingsEntry = {
      enabled: true,
      kind: 'energy',
      enforcement: 'soft',
      targetEnergyKWh,
      deadlineAtMs,
    };
    // Same device-scoped write as the other deadline cards. Re-running it for
    // the deadline already set keeps the energy fed so far (the delivery count
    // is keyed by device and deadline); a new deadline starts a new count.
    throwIfWriteRefused(
      deps.upsertDeferredObjectiveForDevice({ deviceId, deviceName: device.name ?? null, entry }),
    );
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(
      snapshot.filter(supportsEnergyObjective).filter(isOfferedDevice(deps)),
      query,
    );
  });
}
