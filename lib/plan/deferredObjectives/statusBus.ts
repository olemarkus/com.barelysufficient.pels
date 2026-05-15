import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';

export type DeferredObjectiveStatus =
  | 'on_track'
  | 'at_risk'
  | 'cannot_meet'
  | 'satisfied'
  | 'invalid'
  | 'unknown'
  | 'none';

export type DeferredObjectivePublishedStatus = Exclude<DeferredObjectiveStatus, 'none'>;

export type DeferredObjectiveStatusSnapshot = {
  deviceId: string;
  deviceName: string | null;
  kind: DeferredObjectiveDiagnostic['objectiveKind'];
  status: DeferredObjectivePublishedStatus;
  previousStatus: DeferredObjectiveStatus;
  targetText: string;
  targetValue: number | null;
  deadlineLocalTime: string;
  deadlineAtMs: number | null;
  deadlineMissed: boolean;
  shortfallKwh: number | null;
  shortfallText: string | null;
  plannedStartAtMs: number | null;
  plannedFinishAtMs: number | null;
  requiredKwh: number | null;
  planningSpeedKw: number | null;
  estimatedDurationText: string | null;
  // Stable lowercase reason id surfaced when status is `at_risk` /
  // `cannot_meet` / `invalid`. Null when on track or satisfied.
  riskReason: string | null;
};

type Listener = (transition: DeferredObjectiveStatusSnapshot) => void;

export type DeferredObjectiveStatusBus = {
  publish: (transition: DeferredObjectiveStatusSnapshot) => void;
  setCurrent: (snapshot: DeferredObjectiveStatusSnapshot) => void;
  forgetDevice: (deviceId: string) => void;
  getCurrent: (deviceId: string) => DeferredObjectiveStatusSnapshot | null;
  hasActive: (deviceId: string) => boolean;
  listDeviceIds: () => string[];
  onTransition: (listener: Listener) => () => void;
};

export const createDeferredObjectiveStatusBus = (): DeferredObjectiveStatusBus => {
  const current = new Map<string, DeferredObjectiveStatusSnapshot>();
  const transitionListeners = new Set<Listener>();

  return {
    publish: (transition) => {
      current.set(transition.deviceId, transition);
      for (const listener of transitionListeners) listener(transition);
    },
    setCurrent: (snapshot) => {
      current.set(snapshot.deviceId, snapshot);
    },
    forgetDevice: (deviceId) => {
      current.delete(deviceId);
    },
    getCurrent: (deviceId) => current.get(deviceId) ?? null,
    hasActive: (deviceId) => current.has(deviceId),
    listDeviceIds: () => Array.from(current.keys()),
    onTransition: (listener) => {
      transitionListeners.add(listener);
      return () => { transitionListeners.delete(listener); };
    },
  };
};
