import { resolvePhaseFootprintWithSource } from '../lib/phaseFootprint/resolvePhaseFootprint';
import { resolveOperatingChargingPhases } from '../lib/phaseFootprint/chargingPhaseFootprints';
import type { PelsHost } from '../lib/app/pelsHost';
import type { DecoratedDeviceSnapshot } from '../packages/contracts/src/types';
import type { SettingsUiPhaseFootprintRead } from '../packages/contracts/src/settingsUi/devices';

/** Which phases a listed device loads and how PELS knows, from the footprint owner's own rule. */
export const readSettingsUiPhaseFootprint = (
  host: PelsHost,
  device: DecoratedDeviceSnapshot,
  chargerPhaseCurrentsA: readonly [number, number, number] | undefined,
): SettingsUiPhaseFootprintRead => {
  const { footprint, source } = resolvePhaseFootprintWithSource({
    ownerConnection: host.deviceControlSettings.getDevicePhaseConnection(device.id),
    isEvCharger: device.isEvCharger === true,
    chargerPhaseCurrentsA,
    evPreset: device.targetPowerConfig?.preset,
    learned: host.capacityGuard?.phaseLearner.learnedFootprint(device.id),
    operatingPhases: device.isEvCharger ? resolveOperatingChargingPhases(device.steppedLoadProfile) : undefined,
  });
  if (footprint.kind === 'single') return { source, phases: footprint.phase };
  return footprint.kind === 'all_three' ? { source, phases: 'all' } : { source };
};
