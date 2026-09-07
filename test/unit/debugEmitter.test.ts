/**
 * @vitest-environment node
 */
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import {
  getDebugEmitter,
  isDebugTopicEnabled,
  setDebugTopics,
} from '../../lib/logging/logger';

describe('getDebugEmitter', () => {
  let capture: LoggerCapture;

  afterEach(() => { capture?.restore(); });

  it('emits when the topic is on, stamping component and debugTopic', () => {
    capture = captureLogger('debug', ['plan']);
    getDebugEmitter('observer', 'plan')({ event: 'device_near_target_idle_started', deviceId: 'd1' });

    expect(capture.findEvent('device_near_target_idle_started')).toMatchObject({
      component: 'observer',
      debugTopic: 'plan',
      deviceId: 'd1',
    });
  });

  it('emits nothing when the topic is off', () => {
    capture = captureLogger('debug', ['devices']);
    getDebugEmitter('plan', 'plan')({ event: 'restore_admitted' });

    expect(capture.findEvent('restore_admitted')).toBeUndefined();
  });

  it('re-reads the topic set per call, so a settings toggle needs no new emitter', () => {
    capture = captureLogger('debug', []);
    const emit = getDebugEmitter('plan', 'plan');

    emit({ event: 'before_toggle' });
    setDebugTopics(new Set(['plan']));
    emit({ event: 'after_toggle' });

    expect(capture.eventNames()).toEqual(['after_toggle']);
  });

  it('emits at debug even though the root runs at info, as production does', () => {
    capture = captureLogger('info', ['plan']);
    getDebugEmitter('plan', 'plan')({ event: 'restore_rejected' });

    expect(capture.findEvent('restore_rejected')).toMatchObject({ level: 20 });
  });

  it('stays silent until a topic set is published, so an unwired root emits nothing', () => {
    capture = captureLogger('debug', []);
    getDebugEmitter('plan', 'plan')({ event: 'unwired' });

    expect(capture.events).toHaveLength(0);
  });

  it('lets the payload name a component the wiring did not', () => {
    capture = captureLogger('debug', ['devices']);
    getDebugEmitter('devices', 'devices')({ event: 'device_update_processed', component: 'snapshot' });

    expect(capture.findEvent('device_update_processed')).toMatchObject({ component: 'snapshot' });
  });
});

describe('isDebugTopicEnabled', () => {
  let capture: LoggerCapture;

  afterEach(() => { capture?.restore(); });

  it('reports the published set so callers can skip building a payload', () => {
    capture = captureLogger('debug', ['plan', 'devices']);

    expect(isDebugTopicEnabled('plan')).toBe(true);
    expect(isDebugTopicEnabled('price')).toBe(false);
  });

  it('reports every topic off once the capture is restored', () => {
    capture = captureLogger('debug', ['plan']);
    capture.restore();

    expect(isDebugTopicEnabled('plan')).toBe(false);
  });
});
