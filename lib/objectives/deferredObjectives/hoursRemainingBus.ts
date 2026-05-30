// Event bus for "smart task time-remaining crossed an integer-hour boundary
// downward". The domain layer (statusTransitions-adjacent emitter) computes
// the crossing each plan cycle from `deadlineAtMs - nowMs` in real
// milliseconds (DST-safe) and publishes here; the flow card subscribes and
// fires its trigger for matching device + threshold.
//
// Mirrors the shape of `planRevisionBus` / `endedEventBus`: a plain in-process
// fan-out with no Homey SDK coupling, so `lib/plan` stays free of SDK objects.

export type DeferredObjectiveHoursRemainingEvent = {
  deviceId: string;
  deviceName: string | null;
  // Remaining whole hours at this crossing, i.e. the integer-hour boundary the
  // task just dropped to or below (`ceil((deadlineAtMs - nowMs) / hourMs)` at
  // the moment of the crossing). Always >= 1 — crossings are only published for
  // a strictly-future deadline (a passed deadline is the missed/ended surface's
  // job, not this lead-time trigger's).
  hoursRemaining: number;
  // Remaining whole hours at the previous emitted crossing for this
  // (device, deadline), or `null` when this is the first crossing observed for
  // the current deadline (freshly armed / re-armed). Lets the flow run-listener
  // confirm a genuine downward crossing of *its* threshold and fire exactly
  // once, even though the run-listener uses a `<=` comparison.
  previousHoursRemaining: number | null;
};

type Listener = (event: DeferredObjectiveHoursRemainingEvent) => void;

export type DeferredObjectiveHoursRemainingBus = {
  publish: (event: DeferredObjectiveHoursRemainingEvent) => void;
  onCrossing: (listener: Listener) => () => void;
};

export const createDeferredObjectiveHoursRemainingBus = (): DeferredObjectiveHoursRemainingBus => {
  const listeners = new Set<Listener>();
  return {
    publish: (event) => {
      for (const listener of listeners) listener(event);
    },
    onCrossing: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};
