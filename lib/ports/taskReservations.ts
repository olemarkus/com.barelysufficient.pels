/** Economic delivery over original booking coverage, independent of its physical draw window. */
export type TaskEnergyReservation = { startMs: number; endMs: number; plannedKWh: number };

/** Nameplate room held for projected drawing, not an economic energy forecast. */
export type TaskAdmissionReservation = { startMs: number; endMs: number; admissionPowerKw: number };

export type TaskReservationsRead =
  | { kind: 'waiting' }
  | {
    kind: 'ready';
    /** Every active unsatisfied task, including a settled task with no bookings. */
    taskDeviceIds: ReadonlySet<string>;
    energy: readonly TaskEnergyReservation[];
    admission: readonly TaskAdmissionReservation[];
  };

export type TaskReservationSource = {
  /**
   * Managed Main-home membership is resolved by the caller. A started booking's
   * admission window moves forward from now while it remains unsatisfied;
   * economic energy retains its original coverage and is integrated by overlap.
   */
  read(nowMs: number, managedMainDeviceIds: ReadonlySet<string>): TaskReservationsRead;
};
