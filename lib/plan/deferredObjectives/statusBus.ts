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
  deadlineLocalTime: string;
  deadlineAtMs: number | null;
  deadlineMissed: boolean;
  shortfallKwh: number | null;
  shortfallText: string | null;
};

type Listener = (transition: DeferredObjectiveStatusSnapshot) => void;
type MissedListener = (transition: DeferredObjectiveStatusSnapshot) => void;

export type DeferredObjectiveStatusBus = {
  publish: (transition: DeferredObjectiveStatusSnapshot) => void;
  publishMissed: (transition: DeferredObjectiveStatusSnapshot) => void;
  setCurrent: (snapshot: DeferredObjectiveStatusSnapshot) => void;
  forgetDevice: (deviceId: string) => void;
  getCurrent: (deviceId: string) => DeferredObjectiveStatusSnapshot | null;
  hasActive: (deviceId: string) => boolean;
  listDeviceIds: () => string[];
  onTransition: (listener: Listener) => () => void;
  onMissed: (listener: MissedListener) => () => void;
};

export const createDeferredObjectiveStatusBus = (): DeferredObjectiveStatusBus => {
  const current = new Map<string, DeferredObjectiveStatusSnapshot>();
  const transitionListeners = new Set<Listener>();
  const missedListeners = new Set<MissedListener>();

  return {
    publish: (transition) => {
      current.set(transition.deviceId, transition);
      for (const listener of transitionListeners) listener(transition);
    },
    publishMissed: (transition) => {
      current.set(transition.deviceId, transition);
      for (const listener of missedListeners) listener(transition);
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
    onMissed: (listener) => {
      missedListeners.add(listener);
      return () => { missedListeners.delete(listener); };
    },
  };
};
