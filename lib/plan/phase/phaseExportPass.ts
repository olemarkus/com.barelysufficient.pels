/**
 * Export overload (`notes/main-fuse.md`): a phase exporting past its target.
 * Loads are never limited for this. The first remedy is here: a battery
 * discharging on that phase is asked to discharge less, so the rest of the
 * excess, if any, goes to the inverter and then to surplus loads.
 */
import type { PhaseFootprint, PhaseName } from '../../../packages/planner-types/src/phaseFootprint';
import type { PlanContext } from '../planContext';
import { isDrivableLimitScope } from '../shedding/storageCandidate';
import type { StorageSetpoint } from '../shedding/types';
import { toTargetPowerCapabilityValue } from '../../utils/storageSetpoint';
import type { PhasePower } from './phasePower';
import { phaseShare } from './phaseRoom';

export type PhaseExportOutcome = {
  storageSetpoints: Map<string, StorageSetpoint>;
  /** Export past the target left after the batteries, kW: what the inverter is asked to cover. */
  remainingExcessKw: number;
  /** The worst phase exporting past its target this cycle. */
  exportPhase: PhaseName | null;
};

const NO_EXPORT_OUTCOME = (): PhaseExportOutcome => ({
  storageSetpoints: new Map(), remainingExcessKw: 0, exportPhase: null,
});

const touchesPhaseKnown = (footprint: PhaseFootprint, phase: PhaseName): boolean => phaseShare(footprint, phase) > 0;

export function runPhaseExportPass(
  context: PlanContext,
  phasePower: PhasePower,
  excludedIds: ReadonlySet<string>,
): PhaseExportOutcome {
  if (phasePower.kind === 'off') return NO_EXPORT_OUTCOME();
  const worstFirst = phasePower.phases
    .filter((phase) => phase.exportBreached)
    .sort((a, b) => b.exportExcessKw - a.exportExcessKw);
  const [worst] = worstFirst;
  if (worst === undefined) return NO_EXPORT_OUTCOME();
  const batteries = context.devices
    .filter(isDrivableLimitScope)
    .filter((device) => !excludedIds.has(device.id) && device.storage.signedPowerW < 0)
    .sort((a, b) => b.priority - a.priority);
  const storageSetpoints = new Map<string, StorageSetpoint>();
  const remaining = new Map(worstFirst.map((phase) => [phase.phase, phase.exportExcessKw]));
  for (const phase of worstFirst) {
    for (const battery of batteries) {
      const openKw = remaining.get(phase.phase) ?? 0;
      if (openKw <= 0 || storageSetpoints.has(battery.id)) continue;
      if (!touchesPhaseKnown(battery.phaseFootprint, phase.phase)) continue;
      const share = phaseShare(battery.phaseFootprint, phase.phase);
      const raiseW = Math.min(-battery.storage.signedPowerW, (openKw / share) * 1000);
      const setpointW = Math.min(0, toTargetPowerCapabilityValue(
        battery.storage.signedPowerW + raiseW, battery.storage.range,
      ));
      storageSetpoints.set(battery.id, {
        setpointW, banked: false, storage: battery.storage, exportPhase: phase.phase,
      });
      for (const [name, kw] of remaining) {
        remaining.set(name, Math.max(0, kw - (raiseW / 1000) * phaseShare(battery.phaseFootprint, name)));
      }
    }
  }
  return {
    storageSetpoints,
    remainingExcessKw: Math.max(0, ...remaining.values()),
    exportPhase: worst.phase,
  };
}
