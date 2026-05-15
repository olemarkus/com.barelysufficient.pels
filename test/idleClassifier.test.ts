import { createIdleClassifier, type IdleClassifierDeviceInput } from '../lib/observer/idleClassifier';
import {
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
  shedAction: undefined,
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
    const shed = heaterAt({ shedAction: 'turn_off' });
    classifier.classifyAll([shed], t0);
    classifier.classifyAll([shed], t0 + IDLE_HOLD_MIN_DURATION_MS);
    expect(classifier.getClassification('heater-1')).toBeUndefined();
  });
});
