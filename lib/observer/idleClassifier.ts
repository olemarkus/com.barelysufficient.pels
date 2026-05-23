/**
 * Per-plan-cycle wrapper around `classifyIdleState`. Owns the cross-cycle
 * idle streak state, emits structured-log transitions, and exposes the
 * current classification map for the Settings UI read model.
 *
 * The classifier is consumed downstream of plan emission as a UI / diagnostic
 * tap — it does not feed back into planner decisions. Plan-state inputs
 * (shedAction, currentState) are only consulted to gate eligibility so the
 * classifier never reports on a device PELS itself is suppressing.
 */
import {
  classifyIdleState,
  pruneIdleDetectorState,
  type IdleClassification,
  type IdleDetectorInput,
  type IdleDetectorResult,
  type IdleDetectorState,
} from './idleDetector';
import { isFiniteNumber } from '../utils/appTypeGuards';
import type { Logger as PinoLogger } from '../logging/logger';
import { formatIdleClassificationCopy } from '../../packages/shared-domain/src/idleClassificationCopy';

/** Subset of DevicePlanDevice used by the classifier — keeps coupling thin. */
export type IdleClassifierDeviceInput = {
  id: string;
  name: string;
  currentState: string;
  currentOn: boolean;
  observationStale?: boolean;
  measuredPowerKw?: number;
  currentTemperature?: number;
  currentTarget: number | null;
  shedAction?: 'turn_off' | 'set_step' | 'set_temperature';
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
};

export type IdleClassifier = {
  classifyAll: (devices: readonly IdleClassifierDeviceInput[], now: number) => void;
  /**
   * Returns `near_target_idle`, `unresponsive`, or `capped_idle`;
   * undefined for active devices.
   */
  getClassification: (deviceId: string) => Exclude<IdleClassification, 'active'> | undefined;
};

export type IdleClassifierDeps = {
  structuredLog?: PinoLogger;
};

const toDetectorInput = (
  device: IdleClassifierDeviceInput,
  now: number,
): IdleDetectorInput => ({
  deviceId: device.id,
  now,
  measuredPowerKw: device.measuredPowerKw,
  currentTemperature: device.currentTemperature,
  targetTemperature: isFiniteNumber(device.currentTarget) ? device.currentTarget : undefined,
  observedOn: device.currentState === 'on',
  observationStale: device.observationStale,
  pelsCommandedShed: device.shedAction !== undefined,
  hasTemperatureSetpoint: isFiniteNumber(device.currentTarget),
  isEvCharger: device.controlCapabilityId === 'evcharger_charging',
});

type ReportableClassification = Exclude<IdleClassification, 'active'>;

const STARTED_EVENT: Record<ReportableClassification, string> = {
  near_target_idle: 'device_near_target_idle_started',
  unresponsive: 'device_unresponsive_started',
  capped_idle: 'device_capped_idle_started',
};

const CLEARED_EVENT: Record<ReportableClassification, string> = {
  near_target_idle: 'device_near_target_idle_cleared',
  unresponsive: 'device_unresponsive_cleared',
  capped_idle: 'device_capped_idle_cleared',
};

const isReportableClassification = (
  value: IdleClassification | undefined,
): value is ReportableClassification => (
  value === 'near_target_idle' || value === 'unresponsive' || value === 'capped_idle'
);

const emitTransitionLog = (params: {
  device: IdleClassifierDeviceInput;
  result: IdleDetectorResult;
  logger?: PinoLogger;
}): void => {
  const { device, result, logger } = params;
  if (!logger) return;
  const { classification, previousClassification, idleDurationMs, temperatureGapC } = result;

  if (classification === previousClassification) return;

  if (isReportableClassification(previousClassification)) {
    logger.info({
      component: 'observer',
      event: CLEARED_EVENT[previousClassification],
      deviceId: device.id,
      deviceName: device.name,
      idleDurationMs,
      temperatureGapC,
      newClassification: classification,
    });
  }

  if (isReportableClassification(classification)) {
    const copy = formatIdleClassificationCopy({
      classification,
      currentTemperatureC: device.currentTemperature,
      targetTemperatureC: isFiniteNumber(device.currentTarget) ? device.currentTarget : undefined,
    });
    logger.info({
      component: 'observer',
      event: STARTED_EVENT[classification],
      deviceId: device.id,
      deviceName: device.name,
      idleDurationMs,
      temperatureGapC,
      measuredPowerKw: device.measuredPowerKw,
      currentTemperatureC: device.currentTemperature,
      targetTemperatureC: device.currentTarget ?? undefined,
      detail: copy.detail,
    });
  }
};

export function createIdleClassifier(deps: IdleClassifierDeps = {}): IdleClassifier {
  const state: IdleDetectorState = new Map();
  const lastResultById = new Map<string, IdleDetectorResult>();

  const classifyAll = (
    devices: readonly IdleClassifierDeviceInput[],
    now: number,
  ): void => {
    pruneIdleDetectorState(state, devices.map((device) => device.id));
    lastResultById.clear();
    for (const device of devices) {
      const result = classifyIdleState(toDetectorInput(device, now), state);
      emitTransitionLog({ device, result, logger: deps.structuredLog });
      lastResultById.set(device.id, result);
    }
  };

  const getClassification = (
    deviceId: string,
  ): Exclude<IdleClassification, 'active'> | undefined => {
    const result = lastResultById.get(deviceId);
    if (!result) return undefined;
    return result.classification === 'active' ? undefined : result.classification;
  };

  return { classifyAll, getClassification };
}
