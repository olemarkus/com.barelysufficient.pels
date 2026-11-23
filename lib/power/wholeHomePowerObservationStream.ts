import type { WholeHomePowerObservation } from '../ports/homeMeterReadings';

/** Projects accepted whole-home readings without carrying their provenance into timing. */
export class WholeHomePowerObservationStream {
  private lastIdentifiedMeter: string | undefined;
  private generation = 0;

  observe(
    powerW: number, generationW: number | undefined, meterDeviceId: string | undefined,
  ): WholeHomePowerObservation {
    if (meterDeviceId !== undefined) {
      // A reading without an identity can still belong to the same meter.
      if (this.lastIdentifiedMeter !== undefined && this.lastIdentifiedMeter !== meterDeviceId) {
        this.generation += 1;
      }
      this.lastIdentifiedMeter = meterDeviceId;
    }
    return {
      powerW,
      ...(generationW === undefined ? {} : { generationW }),
      streamGeneration: this.generation,
    };
  }
}
