import type { PendingObservationSource } from './controlCommandConfirmation';

/** Binary command facts shared by execution, observation and planner read ports. */
type PendingBinaryCommandLogContext = 'capacity' | 'capacity_control_off';

export type PendingBinaryCommand = {
  dispatchState: 'dispatching' | 'accepted';
  desired: boolean;
  lastResortMaximumW?: number;
  binarySwitchGeneration?: number;
  startedMs: number;
  /**
   * How long the command waits to be confirmed: the device's window when it
   * was sent (`ConfirmationWindows`), kept for the command's whole life.
   */
  confirmationWindowMs: number;
  logContext?: PendingBinaryCommandLogContext;
  /**
   * True for a planned off that is not capacity pressure: a smart-task
   * lifecycle-end disable or a charging-phase hand-back pause. `handleConfirmedBinaryCommand` reads it so
   * a deferred flow-backed off-confirmation routes through the diagnostic-only
   * release recorder and does NOT stamp the capacity cooldown markers
   * (`lastInstabilityMs` / `lastDeviceShedMs`). A lifecycle disable is a planning
   * decision, not capacity pressure.
   */
  lifecycleRelease?: boolean;
  /** Reasserting an already-OFF relay settles without counting a further shed. */
  relayRepeat?: true;
  lastObservedValue?: boolean | string;
  lastObservedSource?: PendingObservationSource;
  lastObservedAtMs?: number;
};

/** Consumer view: only the observer-owned store may update pending entries. */
export type PendingBinaryCommandRead = Readonly<PendingBinaryCommand>;
