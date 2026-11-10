import type { DeviceObjectiveProfile } from '../../packages/contracts/src/objectiveProfileTypes';
import type { SupportReportSection, SupportReportValue } from '../../packages/contracts/src/supportReport';

export const LEARNED_RATES_REPORT_TITLE = 'Learned device rates';

const SAMPLE_COLUMNS = ['observedAtMs', 'inputValue', 'kwhPerUnit', 'outdoorTemperatureC', 'progressDirection'];

const reportDevice = (
  deviceId: string,
  profile: DeviceObjectiveProfile,
  deviceName: (deviceId: string) => string | undefined,
): SupportReportValue => {
  const stat = profile.kwhPerUnit;
  return {
    deviceId,
    deviceName: deviceName(deviceId) ?? null,
    updatedAtMs: profile.updatedAtMs,
    acceptedSamples: profile.acceptedSamples,
    rejectedSamples: profile.rejectedSamples,
    kwhPerUnit: stat ? {
      mean: stat.mean, sampleCount: stat.sampleCount, min: stat.min, max: stat.max,
      confidence: stat.confidence, lastUpdatedMs: stat.lastUpdatedMs,
    } : null,
    // Absent until the first refusal; a profile that has refused nothing reports {}.
    rejections: Object.fromEntries(Object.entries(profile.rejections ?? {}).map(([reason, tally]) => (
      [reason, { count: tally.count, discardedEnergyKWh: tally.discardedEnergyKWh }]
    ))),
    samples: (profile.samples ?? []).map((sample) => [
      sample.observedAtMs, sample.inputValue, sample.kwhPerUnit,
      sample.outdoorTemperatureC ?? null, sample.progressDirection ?? 'increasing',
    ]),
  };
};

/**
 * What each device's objective profile has learned, whether or not it has a
 * smart task: the rate smart tasks are sized from, the windows it rests on and
 * what learning refused or dropped. Main's devices only, as the tracker holds them.
 */
export const reportLearnedRates = (
  profiles: Readonly<Record<string, DeviceObjectiveProfile>> | undefined,
  deviceName: (deviceId: string) => string | undefined,
): SupportReportSection => ({
  title: LEARNED_RATES_REPORT_TITLE,
  values: {
    sampleColumns: SAMPLE_COLUMNS,
    devices: Object.entries(profiles ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([deviceId, profile]) => reportDevice(deviceId, profile, deviceName)),
  },
});
