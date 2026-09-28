/** Provenance of the whole-home watts currently served by the power tracker. */
export type SampledMeterProvenance =
  | { state: 'proven'; deviceId: string }
  | { state: 'unattributable' }
  | { state: 'unknown' };

/** Power-owned identity state consumed by Main-home meter authority. */
export type SampledMeterIdentityPort = {
  resolveFor(nowMs: number): SampledMeterProvenance;
  note(deviceId: string, sampleAtMs: number): void;
  noteFlowReplacement(): void;
};
