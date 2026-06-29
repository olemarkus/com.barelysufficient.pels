import { createIdleClassifier, type IdleClassifierDeviceInput } from '../../lib/observer/idleClassifier';
import {
  CAPPED_IDLE_MIN_WINDOW_MS,
  IDLE_HOLD_MIN_DURATION_MS,
  IDLE_UNRESPONSIVE_MIN_DURATION_MS,
} from '../../lib/observer/idleDetector';

type MockSink = {
  emit: (payload: Record<string, unknown>) => void;
  events: Array<Record<string, unknown>>;
};

const createSink = (): MockSink => {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    emit: (payload) => events.push(payload),
  };
};

const eventNames = (sink: MockSink): string[] => sink.events.map((event) => String(event.event));

const heaterAt = (
  overrides: Partial<IdleClassifierDeviceInput> = {},
): IdleClassifierDeviceInput => ({
  id: 'heater-1',
  name: 'Connected 300',
  currentState: 'on',
  binaryControl: { on: true },
  observationStale: false,
  measuredPowerKw: 0,
  currentTemperature: 61.5,
  currentTarget: 65,
  plannedState: 'keep',
  controlCapabilityId: 'onoff',
  ...overrides,
});

describe('createIdleClassifier', () => {
  // near_target_idle is the benign duty-cycle classification: it must NOT reach
  // the ungated info sink (which feeds the no-debug diagnostics report) — it
  // routes to the topic-gated debug emitter instead.
  it('routes near_target_idle transitions to the debug emitter, not the info sink', () => {
    const info = createSink();
    const debug = createSink();
    const classifier = createIdleClassifier({ structuredLog: { info: info.emit } as never, debugStructured: debug.emit });
    const t0 = 1_000_000;
    classifier.classifyAll([heaterAt()], t0);
    classifier.classifyAll([heaterAt()], t0 + IDLE_HOLD_MIN_DURATION_MS);

    expect(eventNames(debug)).toContain('device_near_target_idle_started');
    expect(eventNames(info)).not.toContain('device_near_target_idle_started');
    expect(classifier.getClassification('heater-1')).toBe('near_target_idle');
  });

  it('routes a near_target_idle cleared transition to the debug emitter', () => {
    const info = createSink();
    const debug = createSink();
    const classifier = createIdleClassifier({ structuredLog: { info: info.emit } as never, debugStructured: debug.emit });
    const t0 = 1_000_000;
    classifier.classifyAll([heaterAt()], t0);
    classifier.classifyAll([heaterAt()], t0 + IDLE_HOLD_MIN_DURATION_MS);
    classifier.classifyAll(
      [heaterAt({ measuredPowerKw: 1.2 })],
      t0 + IDLE_HOLD_MIN_DURATION_MS + 1_000,
    );

    expect(eventNames(debug)).toContain('device_near_target_idle_cleared');
    expect(eventNames(info)).not.toContain('device_near_target_idle_cleared');
    expect(classifier.getClassification('heater-1')).toBeUndefined();
  });

  it('does not emit on a stable active device', () => {
    const info = createSink();
    const debug = createSink();
    const classifier = createIdleClassifier({ structuredLog: { info: info.emit } as never, debugStructured: debug.emit });
    classifier.classifyAll([heaterAt({ measuredPowerKw: 1.0 })], 1_000_000);
    classifier.classifyAll([heaterAt({ measuredPowerKw: 1.0 })], 2_000_000);
    expect(info.events).toHaveLength(0);
    expect(debug.events).toHaveLength(0);
  });

  // unresponsive and capped_idle are the surprising states a no-debug report
  // must keep — they stay on the ungated info sink with a reasonCode.
  it('reports unresponsive on the info sink after the longer window when far from setpoint', () => {
    const info = createSink();
    const debug = createSink();
    const classifier = createIdleClassifier({ structuredLog: { info: info.emit } as never, debugStructured: debug.emit });
    const t0 = 1_000_000;
    const cold = heaterAt({ currentTemperature: 55 });
    classifier.classifyAll([cold], t0);
    classifier.classifyAll([cold], t0 + IDLE_UNRESPONSIVE_MIN_DURATION_MS);
    expect(classifier.getClassification('heater-1')).toBe('unresponsive');
    expect(info.events).toContainEqual(expect.objectContaining({
      event: 'device_unresponsive_started',
      reasonCode: 'unresponsive',
    }));
    expect(eventNames(debug)).not.toContain('device_unresponsive_started');
  });

  it('does not classify a PELS-shed device', () => {
    const classifier = createIdleClassifier();
    const t0 = 1_000_000;
    const shed = heaterAt({ plannedState: 'shed' });
    classifier.classifyAll([shed], t0);
    classifier.classifyAll([shed], t0 + IDLE_HOLD_MIN_DURATION_MS);
    expect(classifier.getClassification('heater-1')).toBeUndefined();
  });

  // Regression: production builds `DevicePlanDevice.shedAction` on every
  // controllable temperature/stepped device (the *shed behaviour*, not the
  // *current command*). An earlier mapping treated any defined `shedAction`
  // as "currently shedding" and the eligibility gate silently rejected
  // every device — zero classifier events emitted on prod for days. The
  // gate must read from `plannedState`, which reflects the actual decision
  // for this cycle.
  it('classifies a keep-planned heater near setpoint even though shed behaviour is configured', () => {
    const info = createSink();
    const debug = createSink();
    const classifier = createIdleClassifier({ structuredLog: { info: info.emit } as never, debugStructured: debug.emit });
    const t0 = 1_000_000;
    const keepingHeater = heaterAt({ plannedState: 'keep' });
    classifier.classifyAll([keepingHeater], t0);
    classifier.classifyAll([keepingHeater], t0 + IDLE_HOLD_MIN_DURATION_MS);
    expect(classifier.getClassification('heater-1')).toBe('near_target_idle');
    expect(eventNames(debug)).toContain('device_near_target_idle_started');
  });

  it('emits a capped_idle started event on the info sink when the device cycles at its own cap', () => {
    // Connected 300 worked example: tank parks at 58 °C (7 °C below the
    // 65 °C target) with power cycling around the device's own
    // hysteresis. The classifier should fire a started event the cycle
    // the full 20-min window is covered.
    const info = createSink();
    const debug = createSink();
    const classifier = createIdleClassifier({ structuredLog: { info: info.emit } as never, debugStructured: debug.emit });
    const t0 = 1_000_000;
    const cappedAt58 = heaterAt({ currentTemperature: 58 });
    let cursor = t0;
    let drawing = true;
    while (cursor <= t0 + CAPPED_IDLE_MIN_WINDOW_MS) {
      classifier.classifyAll(
        [{ ...cappedAt58, measuredPowerKw: drawing ? 1.5 : 0 }],
        cursor,
      );
      cursor += 30_000;
      drawing = !drawing;
    }
    classifier.classifyAll(
      [{ ...cappedAt58, measuredPowerKw: 0 }],
      cursor,
    );
    expect(classifier.getClassification('heater-1')).toBe('capped_idle');
    expect(info.events).toContainEqual(expect.objectContaining({
      event: 'device_capped_idle_started',
      reasonCode: 'capped_idle',
    }));
  });

  // Power-draw edges: characterise self-cycling heaters by logging the
  // temperature at which a commanded-on device stops and resumes drawing.
  describe('power-draw edge logging', () => {
    it('logs a stopped edge (with temperatures) when a commanded-on device drops to ~0 W', () => {
      const info = createSink();
      const debug = createSink();
      const classifier = createIdleClassifier({ structuredLog: { info: info.emit } as never, debugStructured: debug.emit });
      const t0 = 1_000_000;
      classifier.classifyAll([heaterAt({ measuredPowerKw: 1.5, currentTemperature: 59.4 })], t0); // seed: drawing
      classifier.classifyAll([heaterAt({ measuredPowerKw: 0, currentTemperature: 59.4 })], t0 + 10_000); // edge: stopped
      expect(debug.events).toContainEqual(expect.objectContaining({
        event: 'device_power_draw_stopped',
        deviceId: 'heater-1',
        currentTemperatureC: 59.4,
        targetTemperatureC: 65,
        temperatureGapC: 65 - 59.4,
      }));
      expect(eventNames(info)).not.toContain('device_power_draw_stopped');
    });

    it('logs a resumed edge when the device starts drawing again', () => {
      const debug = createSink();
      const classifier = createIdleClassifier({ debugStructured: debug.emit });
      const t0 = 1_000_000;
      classifier.classifyAll([heaterAt({ measuredPowerKw: 0 })], t0); // seed: idle
      classifier.classifyAll([heaterAt({ measuredPowerKw: 1.5 })], t0 + 10_000); // edge: resumed
      expect(eventNames(debug)).toContain('device_power_draw_resumed');
    });

    it('does not log an edge on the first observation (seeds only)', () => {
      const debug = createSink();
      const classifier = createIdleClassifier({ debugStructured: debug.emit });
      classifier.classifyAll([heaterAt({ measuredPowerKw: 0 })], 1_000_000);
      expect(eventNames(debug)).not.toContain('device_power_draw_stopped');
      expect(eventNames(debug)).not.toContain('device_power_draw_resumed');
    });

    it('does not log a power edge while PELS is shedding the device', () => {
      const debug = createSink();
      const classifier = createIdleClassifier({ debugStructured: debug.emit });
      const t0 = 1_000_000;
      classifier.classifyAll([heaterAt({ measuredPowerKw: 1.5, plannedState: 'shed' })], t0);
      classifier.classifyAll([heaterAt({ measuredPowerKw: 0, plannedState: 'shed' })], t0 + 10_000);
      expect(eventNames(debug)).not.toContain('device_power_draw_stopped');
    });

    it('does not log a stopped edge when the observation goes stale (0 W is untrusted)', () => {
      const debug = createSink();
      const classifier = createIdleClassifier({ debugStructured: debug.emit });
      const t0 = 1_000_000;
      classifier.classifyAll([heaterAt({ measuredPowerKw: 1.5 })], t0); // seed: drawing
      classifier.classifyAll([heaterAt({ measuredPowerKw: 0, observationStale: true })], t0 + 10_000);
      expect(eventNames(debug)).not.toContain('device_power_draw_stopped');
    });

    it('ignores a transient non-finite power sample (no spurious stop/resume edge)', () => {
      const debug = createSink();
      const classifier = createIdleClassifier({ debugStructured: debug.emit });
      const t0 = 1_000_000;
      classifier.classifyAll([heaterAt({ measuredPowerKw: 1.5 })], t0); // drawing (seed)
      classifier.classifyAll([heaterAt({ measuredPowerKw: undefined })], t0 + 10_000); // dropout — held, no edge
      classifier.classifyAll([heaterAt({ measuredPowerKw: 1.5 })], t0 + 20_000); // drawing again
      // A missing sample must not be read as "stopped" — it carries no draw-edge info.
      expect(eventNames(debug)).not.toContain('device_power_draw_stopped');
      expect(eventNames(debug)).not.toContain('device_power_draw_resumed');
    });

    it('drops the streak when the device goes off, so it does not fire a spurious resume on return', () => {
      const debug = createSink();
      const classifier = createIdleClassifier({ debugStructured: debug.emit });
      const t0 = 1_000_000;
      classifier.classifyAll([heaterAt({ measuredPowerKw: 1.5 })], t0); // on + drawing (seed)
      classifier.classifyAll([heaterAt({ currentState: 'off', measuredPowerKw: 0 })], t0 + 10_000); // off — streak dropped
      classifier.classifyAll([heaterAt({ measuredPowerKw: 1.5 })], t0 + 20_000); // on + drawing again
      // The on→off→on was PELS/transport, not the device's own coast — no resume edge.
      expect(eventNames(debug)).not.toContain('device_power_draw_resumed');
    });
  });
});
