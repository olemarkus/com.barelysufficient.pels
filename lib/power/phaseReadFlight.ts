import type { MeterPhasesRead } from '../ports/homeMeterReadings';

/** How long a phase read beside a Flow sample may take before its answer is too old to judge against that sample. */
const PHASE_READ_DEADLINE_MS = 3_000;

/**
 * One phase read at a time, never holding the sample that asked for it: a read
 * still in its deadline covers later samples, which use the last accepted
 * phases, and an answer past the deadline is dropped.
 */
export class PhaseReadFlight {
  private startedAtMs: number | null = null;

  begin(
    read: () => Promise<MeterPhasesRead>,
    admit: (result: MeterPhasesRead) => void,
    nowMs: number,
    readClockMs: () => number,
  ): void {
    if (this.startedAtMs !== null && nowMs - this.startedAtMs < PHASE_READ_DEADLINE_MS) return;
    this.startedAtMs = nowMs;
    void read()
      .then((result) => {
        if (readClockMs() - nowMs <= PHASE_READ_DEADLINE_MS) admit(result);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.startedAtMs === nowMs) this.startedAtMs = null;
      });
  }
}
