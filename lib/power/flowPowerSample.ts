import type { Logger } from '../logging/logger';
import type { ConfiguredPowerSourceRead } from '../ports/configuredPowerSource';
import { normalizeError } from '../utils/errorUtils';
import type { SampleAdmission } from './sampleIngestQueue';

type FlowPowerSampleSource = {
  readPowerSource(): ConfiguredPowerSourceRead;
  nowMs(): number;
  observePhases(powerW: number, nowMs: number): void;
  recordPowerSample(powerW: number, nowMs: number): Promise<SampleAdmission>;
  noteAdmittedSample(): void;
  log: Pick<Logger, 'error'>;
};

export const createFlowPowerSampleReceiver = (source: FlowPowerSampleSource) => async (
  powerW: number,
): Promise<void> => {
  const configured = source.readPowerSource();
  if (configured.state === 'suspect') {
    source.log.error({
      event: 'flow_power_sample_source_read_failed',
      reason: configured.reason,
      err: normalizeError(configured.error),
    });
    throw configured.error;
  }
  if (configured.value === 'homey_energy') {
    throw new Error('Power source is set to Power meter. In Limits & safety, set Power source to Flow card.');
  }
  const nowMs = source.nowMs();
  source.observePhases(powerW, nowMs);
  const admission = await source.recordPowerSample(powerW, nowMs);
  // Only the sample that won the ingest queue can replace sampled-meter authority.
  if (admission.state !== 'admitted') return;
  // If the source switched during ingest, the next meter poll owns its readings.
  const current = source.readPowerSource();
  if (current.state === 'resolved' && current.value === 'flow') source.noteAdmittedSample();
};
