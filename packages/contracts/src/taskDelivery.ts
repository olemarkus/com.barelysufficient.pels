/** Device-neutral facts recorded while a smart task owns delivery. */
export type TaskDeliveryCause =
  | 'capacity_limited' | 'budget_limited' | 'priority_limited'
  | 'device_not_accepting' | 'device_limit' | 'device_schedule' | 'control_pending'
  | 'control_failed' | 'uncontrolled' | 'observation_unavailable'
  | 'progress_unavailable' | 'rate_insufficient' | 'estimate_uncertain'
  | 'delivery_unfulfilled' | 'legacy_unrecorded';

export type TaskDeliveryControl =
  | { kind: 'permitted' }
  | { kind: 'restricted'; cause: TaskDeliveryCause }
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'uncontrolled' }
  | { kind: 'no_decision' };

export type TaskDeliveryBlocker = { kind: 'clear' } | { kind: 'blocked'; cause: TaskDeliveryCause };
export type TaskDeliveryInterval = { fromMs: number; toMs: number; cause: TaskDeliveryCause };
export type TaskDeliveryExplanation =
  | { kind: 'legacy_unrecorded' }
  | {
    kind: 'recorded';
    primary: TaskDeliveryBlocker;
    contributors: TaskDeliveryCause[];
    intervals: TaskDeliveryInterval[];
  };

/** In-flight persistence carries evidence, never a restart-spanning power anchor. */
export type TaskDeliveryEvidence = {
  explanation: TaskDeliveryExplanation;
  // `stopped` and `rechecking` keep a confirmed stop for the status without
  // freeing reservations; see `TaskNonDeliveryState` in lib/objectives.
  nonDelivery:
    | { kind: 'none' }
    | { kind: 'watching'; sinceMs: number }
    | { kind: 'confirmed'; sinceMs: number }
    | { kind: 'stopped'; sinceMs: number }
    | { kind: 'rechecking'; sinceMs: number };
};

/** Device-owned constraint independent of the task's unit or underlying control type. */
export type TaskDeviceConstraint =
  | { kind: 'none' }
  | { kind: 'limit_reached' }
  | { kind: 'self_stopped'; cause: 'device_not_accepting' | 'device_schedule' };
