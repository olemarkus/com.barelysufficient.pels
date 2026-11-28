import type { PhaseFootprint } from '../../../packages/planner-types/src/phaseFootprint';
import type { StorageRelief } from '../battery/storageRelief';
import { drawMarginWFor, hasStorageInput } from '../battery/storageLadder';
import { phaseShare } from '../phase/phaseRoom';
import type { MeasuredPower, PlanContext } from '../planContext';
import type { StorageShedCandidate } from './types';

type BatteryDraw = {
  footprint: PhaseFootprint;
  chargeW: number;
  observedDischargeW: number;
  undeliveredDischargeW: number;
};

/** One build's import that batteries may take out before causing export. */
export class StorageDischargeBudget {
  private readonly draws = new Map<string, BatteryDraw>();

  constructor(context: PlanContext, private readonly power: MeasuredPower, storage: StorageRelief) {
    for (const device of context.devices) {
      if (!hasStorageInput(device)) continue;
      const lever = storage.levers[device.id];
      if (device.storage.reading === 'watched') continue;
      const signedW = device.storage.reading === 'observed' ? device.storage.signedPowerW : 0;
      const observedDischargeW = Math.max(0, -signedW);
      this.draws.set(device.id, {
        footprint: device.phaseFootprint,
        chargeW: Math.max(0, signedW),
        observedDischargeW,
        undeliveredDischargeW: Math.max(0, -(lever?.setpointW ?? 0) - observedDischargeW),
      });
    }
  }

  roomW(candidate: StorageShedCandidate): number {
    const own = this.draws.get(candidate.id);
    if (own === undefined) return 0;
    const baseDischargeW = Math.max(0, -candidate.baseW);
    const ownUndeliveredW = Math.max(0, baseDischargeW - own.observedDischargeW);
    const marginW = drawMarginWFor(candidate.storage);
    const drains = [...this.draws.values()];
    // Charging from another battery cannot fund this one's discharge.
    const reservedW = drains.reduce((sum, item) => sum + item.chargeW + item.undeliveredDischargeW, 0);
    const ownCreditW = own.undeliveredDischargeW - ownUndeliveredW;
    const roomW = this.power.drawKw * 1000 - reservedW + ownCreditW - marginW;
    if (this.power.phase.kind === 'off') return Math.max(0, roomW);
    if (own.footprint.kind !== 'single' && own.footprint.kind !== 'all_three') return 0;
    const phaseRoomW = this.power.phase.phases.flatMap((phase) => {
      const share = phaseShare(own.footprint, phase.phase);
      if (share <= 0) return [];
      const reserved = drains.reduce((sum, item) => (
        sum + (item.chargeW + item.undeliveredDischargeW) * phaseShare(item.footprint, phase.phase)
      ), 0);
      return [(phase.drawKw * 1000 - reserved) / share + ownCreditW - marginW];
    });
    return Math.max(0, Math.min(roomW, ...phaseRoomW));
  }

  reserve(deviceId: string, setpointW: number): void {
    const own = this.draws.get(deviceId);
    if (own === undefined) return;
    this.draws.set(deviceId, {
      ...own, undeliveredDischargeW: Math.max(own.undeliveredDischargeW, -setpointW - own.observedDischargeW),
    });
  }
}
