import { reportLearnedRates } from '../../lib/diagnostics/supportReportLearnedRates';

describe('learned device rates report section', () => {
  it('reports each profile with its rate, samples and rejection tally', () => {
    const section = reportLearnedRates({
      heater: {
        updatedAtMs: 5,
        lastSample: { observedAtMs: 5, value: 21 },
        acceptedSamples: 3,
        rejectedSamples: 1,
        kwhPerUnit: { sampleCount: 2, mean: 0.8, m2: 0.01, min: 0.7, max: 0.9, confidence: 'low', lastUpdatedMs: 4 },
        samples: [{ observedAtMs: 4, inputValue: 20.5, kwhPerUnit: 0.8, outdoorTemperatureC: 5 }],
        rejections: { objective_profile_powerless_sub_interval: { count: 2, discardedEnergyKWh: 1.2 } },
      },
      idle: { updatedAtMs: 1, lastSample: { observedAtMs: 1, value: 50 }, acceptedSamples: 0, rejectedSamples: 0 },
    }, (deviceId) => (deviceId === 'heater' ? 'Office' : undefined));

    expect(section.values.devices).toEqual([
      {
        deviceId: 'heater', deviceName: 'Office', updatedAtMs: 5, acceptedSamples: 3, rejectedSamples: 1,
        kwhPerUnit: { mean: 0.8, sampleCount: 2, min: 0.7, max: 0.9, confidence: 'low', lastUpdatedMs: 4 },
        rejections: { objective_profile_powerless_sub_interval: { count: 2, discardedEnergyKWh: 1.2 } },
        samples: [[4, 20.5, 0.8, 5, 'increasing']],
      },
      {
        deviceId: 'idle', deviceName: null, updatedAtMs: 1, acceptedSamples: 0, rejectedSamples: 0,
        kwhPerUnit: null, rejections: {}, samples: [],
      },
    ]);
  });

  it('reports no devices before any profile exists', () => {
    expect(reportLearnedRates(undefined, () => undefined).values.devices).toEqual([]);
  });
});
