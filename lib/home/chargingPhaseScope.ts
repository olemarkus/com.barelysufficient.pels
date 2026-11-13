import type { ChargingPhaseSource } from '../ports/chargingPhases';
import type { HomeMembershipPort } from './membership';
import { isSettledMainHomeMember } from './wholeHomeDeviceListing';

/** Main owns phase control. Keep moved devices readable so their original setting can be returned. */
export class MainHomeChargingPhaseSource implements ChargingPhaseSource {
  constructor(private readonly source: ChargingPhaseSource, private readonly membership: HomeMembershipPort) {}

  readDevices(): ReturnType<ChargingPhaseSource['readDevices']> {
    return this.source.readDevices().map((device) => ({
      ...device,
      controlEnabled: device.controlEnabled && isSettledMainHomeMember(this.membership, device.deviceId),
    }));
  }

  envelopes(device: Parameters<ChargingPhaseSource['envelopes']>[0]): ReturnType<ChargingPhaseSource['envelopes']> {
    return this.source.envelopes(device);
  }

  observedPoint(
    ...args: Parameters<ChargingPhaseSource['observedPoint']>
  ): ReturnType<ChargingPhaseSource['observedPoint']> {
    return this.source.observedPoint(...args);
  }

  isSimulation(): boolean { return this.source.isSimulation(); }

  releasePlanningEnvelope(deviceId: string, forceSinglePhase: boolean): void {
    this.source.releasePlanningEnvelope(deviceId, forceSinglePhase);
  }
}
