import {
  createObservationEmitGate,
  OBSERVATION_EMIT_HEARTBEAT_MS,
} from '../../lib/device/observationEmitGate';

const buildGate = () => {
  const emitted: Record<string, unknown>[] = [];
  let nowMs = 1_000_000;
  const gate = createObservationEmitGate({
    emit: (payload) => { emitted.push(payload); },
    now: () => nowMs,
  });
  return {
    gate,
    emitted,
    advance: (ms: number) => { nowMs += ms; },
  };
};

describe('createObservationEmitGate', () => {
  it('emits the first payload and suppresses an identical repeat', () => {
    const { gate, emitted } = buildGate();
    gate({ event: 'solar_production_observed', productionW: 23.3, solarDeviceCount: 1 });
    gate({ event: 'solar_production_observed', productionW: 23.3, solarDeviceCount: 1 });
    gate({ event: 'solar_production_observed', productionW: 23.3, solarDeviceCount: 1 });
    expect(emitted).toEqual([
      { event: 'solar_production_observed', productionW: 23.3, solarDeviceCount: 1 },
    ]);
  });

  it('emits every change, however small', () => {
    const { gate, emitted } = buildGate();
    gate({ event: 'solar_production_observed', productionW: 7.6 });
    gate({ event: 'solar_production_observed', productionW: 23.3 });
    gate({ event: 'solar_production_observed', productionW: 0 });
    expect(emitted.map((entry) => entry.productionW)).toEqual([7.6, 23.3, 0]);
  });

  it('re-emits an unchanged payload once the heartbeat interval has elapsed', () => {
    const { gate, emitted, advance } = buildGate();
    gate({ event: 'solar_production_observed', productionW: 0 });
    advance(OBSERVATION_EMIT_HEARTBEAT_MS - 1);
    gate({ event: 'solar_production_observed', productionW: 0 });
    expect(emitted).toHaveLength(1);

    advance(1);
    gate({ event: 'solar_production_observed', productionW: 0 });
    expect(emitted).toHaveLength(2);
  });

  it('measures the heartbeat from the last EMISSION, not the last suppressed repeat', () => {
    // Refreshing the timestamp on a suppressed repeat would push the deadline
    // out forever on a 1/min producer, and the heartbeat would never fire.
    const { gate, emitted, advance } = buildGate();
    gate({ event: 'solar_production_observed', productionW: 0 });
    for (let index = 0; index < 20; index += 1) {
      advance(60_000);
      gate({ event: 'solar_production_observed', productionW: 0 });
    }
    expect(emitted).toHaveLength(2);
  });

  it('tracks each event name independently', () => {
    const { gate, emitted } = buildGate();
    gate({ event: 'solar_production_observed', productionW: 0 });
    gate({ event: 'battery_state_observed', batterySoc: 50 });
    gate({ event: 'solar_production_observed', productionW: 0 });
    gate({ event: 'battery_state_observed', batterySoc: 50 });
    expect(emitted.map((entry) => entry.event)).toEqual([
      'solar_production_observed',
      'battery_state_observed',
    ]);
  });

  it('compares against the last emitted payload, so an A-B-A sequence emits three times', () => {
    const { gate, emitted } = buildGate();
    gate({ event: 'solar_production_observed', productionW: 10 });
    gate({ event: 'solar_production_observed', productionW: 20 });
    gate({ event: 'solar_production_observed', productionW: 10 });
    expect(emitted.map((entry) => entry.productionW)).toEqual([10, 20, 10]);
  });

  it('treats a differing key set as a change', () => {
    const { gate, emitted } = buildGate();
    gate({ event: 'solar_production_observed', productionW: 0 });
    gate({ event: 'solar_production_observed', productionW: 0, solarDeviceCount: 1 });
    expect(emitted).toHaveLength(2);
  });

  it('passes through a payload with no usable event name rather than swallowing it', () => {
    const { gate, emitted } = buildGate();
    gate({ productionW: 0 });
    gate({ productionW: 0 });
    gate({ event: '', productionW: 0 });
    expect(emitted).toHaveLength(3);
  });

  it('fails open on a non-scalar value instead of deep-comparing it', () => {
    const { gate, emitted } = buildGate();
    gate({ event: 'ev_car_link_observed', candidates: ['a'] });
    gate({ event: 'ev_car_link_observed', candidates: ['a'] });
    expect(emitted).toHaveLength(2);
  });
});
