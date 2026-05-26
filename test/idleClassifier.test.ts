import { createIdleClassifier, type IdleClassifierDeviceInput } from '../lib/observer/idleClassifier';
import {
  CAPPED_IDLE_MIN_WINDOW_MS,
  IDLE_HOLD_MIN_DURATION_MS,
  IDLE_UNRESPONSIVE_MIN_DURATION_MS,
} from '../lib/observer/idleDetector';

type MockLogger = {
  info: (payload: Record<string, unknown>) => void;
  events: Array<Record<string, unknown>>;
};

const createMockLogger = (): MockLogger => {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    info: (payload) => events.push(payload),
  };
};

const heaterAt = (
  overrides: Partial<IdleClassifierDeviceInput> = {},
): IdleClassifierDeviceInput => ({
  id: 'heater-1',
  name: 'Connected 300',
  currentState: 'on',
  currentOn: true,
  observationStale: false,
  measuredPowerKw: 0,
  currentTemperature: 61.5,
  currentTarget: 65,
  plannedState: 'keep',
  controlCapabilityId: 'onoff',
  ...overrides,
});

describe('createIdleClassifier', () => {
  it('emits a started event on first transition into near_target_idle', () => {
    const logger = createMockLogger();
    const classifier = createIdleClassifier({ structuredLog: logger as never });
    const t0 = 1_000_000;
    classifier.classifyAll([heaterAt()], t0);
    classifier.classifyAll([heaterAt()], t0 + IDLE_HOLD_MIN_DURATION_MS);
    const started = logger.events.find(
      (event) => event.event === 'device_near_target_idle_started',
    );
    expect(started).toBeDefined();
    expect(started?.deviceId).toBe('heater-1');
    expect(classifier.getClassification('heater-1')).toBe('near_target_idle');
  });

  it('emits a cleared event when the device resumes', () => {
    const logger = createMockLogger();
    const classifier = createIdleClassifier({ structuredLog: logger as never });
    const t0 = 1_000_000;
    classifier.classifyAll([heaterAt()], t0);
    classifier.classifyAll([heaterAt()], t0 + IDLE_HOLD_MIN_DURATION_MS);
    classifier.classifyAll(
      [heaterAt({ measuredPowerKw: 1.2 })],
      t0 + IDLE_HOLD_MIN_DURATION_MS + 1_000,
    );
    const cleared = logger.events.find(
      (event) => event.event === 'device_near_target_idle_cleared',
    );
    expect(cleared).toBeDefined();
    expect(classifier.getClassification('heater-1')).toBeUndefined();
  });

  it('does not emit on a stable active device', () => {
    const logger = createMockLogger();
    const classifier = createIdleClassifier({ structuredLog: logger as never });
    classifier.classifyAll([heaterAt({ measuredPowerKw: 1.0 })], 1_000_000);
    classifier.classifyAll([heaterAt({ measuredPowerKw: 1.0 })], 2_000_000);
    expect(logger.events).toHaveLength(0);
  });

  it('reports unresponsive after the longer window when far from setpoint', () => {
    const logger = createMockLogger();
    const classifier = createIdleClassifier({ structuredLog: logger as never });
    const t0 = 1_000_000;
    const cold = heaterAt({ currentTemperature: 55 });
    classifier.classifyAll([cold], t0);
    classifier.classifyAll([cold], t0 + IDLE_UNRESPONSIVE_MIN_DURATION_MS);
    expect(classifier.getClassification('heater-1')).toBe('unresponsive');
    expect(
      logger.events.some((event) => event.event === 'device_unresponsive_started'),
    ).toBe(true);
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
    const logger = createMockLogger();
    const classifier = createIdleClassifier({ structuredLog: logger as never });
    const t0 = 1_000_000;
    const keepingHeater = heaterAt({ plannedState: 'keep' });
    classifier.classifyAll([keepingHeater], t0);
    classifier.classifyAll([keepingHeater], t0 + IDLE_HOLD_MIN_DURATION_MS);
    expect(classifier.getClassification('heater-1')).toBe('near_target_idle');
    expect(
      logger.events.some((event) => event.event === 'device_near_target_idle_started'),
    ).toBe(true);
  });

  it('emits a capped_idle started event when the device cycles at its own cap', () => {
    // Connected 300 worked example: tank parks at 58 °C (7 °C below the
    // 65 °C target) with power cycling around the device's own
    // hysteresis. The classifier should fire a started event the cycle
    // the full 20-min window is covered.
    const logger = createMockLogger();
    const classifier = createIdleClassifier({ structuredLog: logger as never });
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
    expect(
      logger.events.some((event) => event.event === 'device_capped_idle_started'),
    ).toBe(true);
  });
});
