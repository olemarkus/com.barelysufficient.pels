import { estimatePower } from '../../lib/device/devicePowerEstimate';
import type { PowerEstimateState } from '../../lib/device/devicePowerEstimate';
import type { LearnedPeaksByDeviceId } from '../../lib/device/devicePowerPeak';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';

const logger = {
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  structuredLog: {
    debug: vi.fn(),
  },
} as unknown as Logger;

const buildState = (): Required<PowerEstimateState> => ({
  expectedPowerKwOverrides: {} as Record<string, { kw: number; ts: number }>,
  lastKnownPowerKw: {} as LearnedPeaksByDeviceId,
  lastEstimateDecisionLogByDevice: new Map(),
  lastPeakPowerLogByDevice: new Map(),
});

const buildDevice = (load?: number): HomeyDeviceLike => ({
  id: 'dev-1',
  name: 'Device 1',
  class: 'thermostat',
  capabilities: ['target_temperature', 'measure_temperature'],
  capabilitiesObj: {
    target_temperature: { value: 21, units: '°C' },
    measure_temperature: { value: 20, units: '°C' },
  },
  settings: load === undefined ? {} : { load },
});

const buildSocketDevice = (params?: {
  onoff?: boolean;
  energyObj?: Record<string, unknown> | null;
  settings?: Record<string, unknown>;
}): HomeyDeviceLike => ({
  id: 'dev-socket-1',
  name: 'Socket 1',
  class: 'socket',
  capabilities: ['onoff'],
  capabilitiesObj: {
    onoff: { value: params?.onoff ?? true },
  },
  settings: params?.settings,
  energyObj: params?.energyObj ?? null,
});

describe('estimatePower', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dedupes unchanged estimate decisions across repeated reads', () => {
    const state = buildState();

    estimatePower({
      device: buildDevice(650),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      now: Date.now(),
      state,
      logger,
    });

    estimatePower({
      device: buildDevice(650),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      now: Date.now() + 1000,
      state,
      logger,
    });

    expect(logger.structuredLog.debug).toHaveBeenCalledTimes(1);
    expect(logger.structuredLog.debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_estimate_source_changed',
      source: 'load-setting',
      estimatedKw: 0.65,
    }));
  });

  it('logs again when the estimate source materially changes', () => {
    const state = buildState();

    estimatePower({
      device: buildDevice(),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      now: Date.now(),
      state,
      logger,
    });

    estimatePower({
      device: buildDevice(650),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      now: Date.now() + 1000,
      state,
      logger,
    });

    expect(logger.structuredLog.debug).toHaveBeenCalledTimes(2);
    expect(logger.structuredLog.debug).toHaveBeenNthCalledWith(1, expect.objectContaining({
      event: 'power_estimate_source_changed',
      source: 'default',
    }));
    expect(logger.structuredLog.debug).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event: 'power_estimate_source_changed',
      source: 'load-setting',
      estimatedKw: 0.65,
    }));
  });

  it('treats settings.load=0 as unset', () => {
    const result = estimatePower({
      device: buildDevice(0),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      now: Date.now(),
      state: buildState(),
      logger,
    });
    expect(result.expectedPowerSource).toBe('default');
    expect(result.expectedPowerKw).toBe(1);
  });

  // `settings.load` no longer seeds the learned peak. That write put a declared
  // nameplate into a store named "measured peak", so a device could later report
  // `expectedPowerSource: 'measured-peak'` for a number no meter ever produced.
  it('uses settings.load when value is greater than zero, and does not seed the peak', () => {
    const result = estimatePower({
      device: buildDevice(650),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      now: Date.now(),
      state: buildState(),
      logger,
    });
    expect(result.expectedPowerSource).toBe('load-setting');
    expect(result.expectedPowerKw).toBeCloseTo(0.65, 3);
  });

  it('passes measuredPowerKw through while using a load-setting estimate', () => {
    const result = estimatePower({
      device: buildDevice(650),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      measuredPowerKw: 0.125,
      now: Date.now(),
      state: buildState(),
      logger,
    });

    expect(result.expectedPowerSource).toBe('load-setting');
    expect(result.expectedPowerKw).toBeCloseTo(0.65, 3);
  });

  it('uses Homey energy approximation delta (usageOn - usageOff) when available', () => {
    const result = estimatePower({
      device: buildSocketDevice({
        onoff: true,
        energyObj: {
          approximation: {
            usageOn: 110,
            usageOff: 10,
          },
        },
      }),
      deviceId: 'dev-socket-1',
      deviceLabel: 'Socket 1',
      now: Date.now(),
      state: buildState(),
      logger,
    });

    expect(result.expectedPowerSource).toBe('homey-energy');
    expect(result.expectedPowerKw).toBeCloseTo(0.1, 6);
    expect(result.expectedPowerKw).toBeCloseTo(0.1, 6);
    expect(result.hasEnergyEstimate).toBe(true);
  });

  it('uses canonical device settings energy values when available (usageOn - usageOff)', () => {
    const result = estimatePower({
      device: buildSocketDevice({
        onoff: false,
        settings: {
          energy_value_on: 12.5,
          energy_value_off: 0,
        },
        energyObj: {
          approximation: {
            usageOn: 110,
            usageOff: 10,
          },
        },
      }),
      deviceId: 'dev-socket-1',
      deviceLabel: 'Socket 1',
      now: Date.now(),
      state: buildState(),
      logger,
    });

    expect(result.expectedPowerSource).toBe('homey-energy');
    expect(result.expectedPowerKw).toBeCloseTo(0.0125, 6);
    expect(result.expectedPowerKw).toBeCloseTo(0.0125, 6);
    expect(result.hasEnergyEstimate).toBe(true);
  });

  it('ignores Homey energy usageConstant when delta/on-state estimates are unavailable', () => {
    const result = estimatePower({
      device: buildSocketDevice({
        onoff: true,
        energyObj: {
          approximation: {
            usageConstant: 350,
          },
        },
      }),
      deviceId: 'dev-socket-1',
      deviceLabel: 'Socket 1',
      now: Date.now(),
      state: buildState(),
      logger,
    });

    expect(result.expectedPowerSource).toBe('default');
    expect(result.expectedPowerKw).toBe(1);
    expect(result.hasEnergyEstimate).toBeUndefined();
  });

  it('falls back to energyObj.W when approximation is unavailable', () => {
    const result = estimatePower({
      device: buildSocketDevice({
        onoff: true,
        energyObj: { W: 125 },
      }),
      deviceId: 'dev-socket-1',
      deviceLabel: 'Socket 1',
      now: Date.now(),
      state: buildState(),
      logger,
    });

    expect(result.expectedPowerSource).toBe('homey-energy');
    expect(result.expectedPowerKw).toBeCloseTo(0.125, 6);
    expect(result.expectedPowerKw).toBeCloseTo(0.125, 6);
    expect(result.hasEnergyEstimate).toBe(true);
  });

  it('does not use energyObj.W when device is explicitly off', () => {
    const result = estimatePower({
      device: buildSocketDevice({
        onoff: false,
        energyObj: { W: 125 },
      }),
      deviceId: 'dev-socket-1',
      deviceLabel: 'Socket 1',
      now: Date.now(),
      state: buildState(),
      logger,
    });

    expect(result.expectedPowerSource).toBe('default');
    expect(result.expectedPowerKw).toBe(1);
    expect(result.hasEnergyEstimate).toBeUndefined();
  });
  // The raw candidates are no longer published on `PowerEstimateResult` — they
  // are inputs to a decision the result reports the OUTPUT of. They are still
  // recorded, against the decision, by the estimator itself. This is the
  // diagnostic that would have named the reported bug in one line.
  it('records the losing candidates on the decision log, not on the result', () => {
    const state = buildState();
    const result = estimatePower({
      device: buildDevice(650), deviceId: 'dev-1', deviceLabel: 'Device 1',
      measuredPowerKw: 2.1, now: Date.now(), state, logger,
    });

    expect(result).not.toHaveProperty('measuredPowerKw');
    expect(result).not.toHaveProperty('loadKw');
    expect(logger.structuredLog.debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_estimate_source_changed',
      source: 'load-setting',
      estimatedKw: 0.65,
      measuredPowerKw: 2.1,
      loadKw: 0.65,
    }));
  });

  // ── The one ordered ladder ──────────────────────────────────────────────────
  // manual › settings.load › measured peak › homey-energy › default.
  // One test per rung, plus the two precedence rules that changed with it.

  it('rung 1 — a manual override outranks every other source', () => {
    const state = buildState();
    state.expectedPowerKwOverrides['dev-1'] = { kw: 2.4, ts: 0 };
    state.lastKnownPowerKw['dev-1'] = { kw: 3.1, observedAtMs: Date.now() };
    const result = estimatePower({
      device: buildDevice(650), deviceId: 'dev-1', deviceLabel: 'Device 1',
      now: Date.now(), state, logger,
    });
    expect(result.expectedPowerSource).toBe('manual');
    expect(result.expectedPowerKw).toBeCloseTo(2.4, 6);
  });

  it('a manual override is an instruction — a HIGHER measurement does not supersede it', () => {
    // The old ladder promoted a measurement above the override to `measured-peak`,
    // so typing 2.4 kW could silently render as something else. Under-declaring is
    // safe on the axis that matters: restore sizing takes
    // max(currentDraw, expected, planning), so a device really pulling more still
    // reserves what it is drawing.
    const state = buildState();
    state.expectedPowerKwOverrides['dev-1'] = { kw: 2.4, ts: 0 };
    const result = estimatePower({
      device: buildDevice(), deviceId: 'dev-1', deviceLabel: 'Device 1',
      measuredPowerKw: 5, now: Date.now(), state, logger,
    });
    expect(result.expectedPowerSource).toBe('manual');
    expect(result.expectedPowerKw).toBeCloseTo(2.4, 6);
  });

  it('rung 1 — a junk override falls through instead of resolving', () => {
    // Every rung is finiteness-and-positivity gated, so the contract's promise
    // that `expectedPowerKw` is a usable number does not rest on the writers of
    // the override map. A 0 or NaN override is not an instruction, it is junk.
    const state = buildState();
    state.expectedPowerKwOverrides['dev-1'] = { kw: 0, ts: 0 };
    const result = estimatePower({
      device: buildDevice(900), deviceId: 'dev-1', deviceLabel: 'Device 1',
      now: Date.now(), state, logger,
    });
    expect(result.expectedPowerSource).toBe('load-setting');
    expect(result.expectedPowerKw).toBeCloseTo(0.9, 6);
  });

  it('rung 2 — a declared settings.load outranks a HIGHER learned peak', () => {
    // Decided precedence: a declared load is what the device says about itself,
    // and the way to correct a wrong one is the manual override on the rung above.
    const state = buildState();
    state.lastKnownPowerKw['dev-1'] = { kw: 3.1, observedAtMs: Date.now() };
    const result = estimatePower({
      device: buildDevice(900), deviceId: 'dev-1', deviceLabel: 'Device 1',
      now: Date.now(), state, logger,
    });
    expect(result.expectedPowerSource).toBe('load-setting');
    expect(result.expectedPowerKw).toBeCloseTo(0.9, 6);
  });

  it('rung 3 — the learned peak wins once no load is declared', () => {
    const state = buildState();
    state.lastKnownPowerKw['dev-1'] = { kw: 3.1, observedAtMs: Date.now() };
    const result = estimatePower({
      device: buildDevice(), deviceId: 'dev-1', deviceLabel: 'Device 1',
      now: Date.now(), state, logger,
    });
    expect(result.expectedPowerSource).toBe('measured-peak');
    expect(result.expectedPowerKw).toBeCloseTo(3.1, 6);
  });

  it('rung 5 — a device nothing is known about resolves to the 1 kW default, not to absence', () => {
    const result = estimatePower({
      device: buildDevice(), deviceId: 'dev-1', deviceLabel: 'Device 1',
      now: Date.now(), state: buildState(), logger,
    });
    expect(result.expectedPowerSource).toBe('default');
    expect(result.expectedPowerKw).toBe(1);
  });

  it('rung 5 — an EV charger with no evidence gets the typical single-phase start', () => {
    // 1.38 kW used to live in `getRestoreDrawKw` as a restore-axis fallback and
    // was unreachable there: every device carried a positive `powerKw`, so the
    // ladder above it never came up empty. Moving it to the rung that actually
    // decides makes it live again.
    const result = estimatePower({
      device: buildDevice(), deviceId: 'dev-ev', deviceLabel: 'Charger',
      controlCapabilityId: 'evcharger_charging',
      now: Date.now(), state: buildState(), logger,
    });
    expect(result.expectedPowerSource).toBe('default');
    expect(result.expectedPowerKw).toBeCloseTo(1.38, 6);
  });
});
