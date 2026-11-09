import type { SettingsUiPhaseLoad } from '../../../contracts/src/settingsUi/power.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';

const NONE: SettingsUiPhaseLoad = { state: 'none' };

/** Re-validate the runtime's phase load at the browser boundary; anything else shows no phases. */
export const classifyPhaseLoad = (value: unknown): SettingsUiPhaseLoad => {
  if (isUnknownRecord(value) && value.state === 'none' && Array.isArray(value.meterCapabilityIds)) {
    return {
      state: 'none',
      meterCapabilityIds: value.meterCapabilityIds.filter((id): id is string => typeof id === 'string'),
      ...(value.phasesRecognised === true ? { phasesRecognised: true } : {}),
    };
  }
  if (!isUnknownRecord(value) || value.state !== 'phases' || !Array.isArray(value.phases)) return NONE;
  const { fuseAmps } = value;
  if (typeof fuseAmps !== 'number' || !Number.isFinite(fuseAmps) || fuseAmps <= 0) return NONE;
  const phases = value.phases.flatMap((entry: unknown) => (
    isUnknownRecord(entry) && typeof entry.phase === 'string'
    && typeof entry.amps === 'number' && Number.isFinite(entry.amps)
      ? [{
        phase: entry.phase,
        amps: entry.amps,
        ...(entry.exporting === true ? { exporting: true as const } : {}),
      }] : []
  ));
  if (phases.length !== 3) return NONE;
  const ids = Array.isArray(value.meterCapabilityIds)
    ? value.meterCapabilityIds.filter((id): id is string => typeof id === 'string') : [];
  const powerOnly = value.powerOnly === true ? { powerOnly: true as const } : {};
  return { state: 'phases', fuseAmps, phases, ...powerOnly, ...(ids.length > 0 ? { meterCapabilityIds: ids } : {}) };
};
