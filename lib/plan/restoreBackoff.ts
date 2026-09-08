import { RESTORE_COOLDOWN_MS, STARTUP_RESTORE_BLOCK_MS } from './planConstants';

/** The adaptive restore cooldown the last restore pass resolved, and the instability it last bumped on. */
export type RestoreCooldownState = {
  restoreCooldownMs: number;
  lastRestoreCooldownBumpMs: number | null;
};

/**
 * The restore back-off: how long restores wait after the house was unstable,
 * and when it last was. One per `PlanEngineState`, owned by the restore pass
 * (`lib/plan/restore/timing.ts` resolves the adaptive 60–300 s cooldown from
 * it and the builder commits the answer back). Three things stamp the
 * instability clock — the executor's capacity turn-off, the silent-meter
 * pass, and a shedding outcome — and the shedding pass's guard update stamps
 * the recovery. The startup block is opened when an engine comes up and
 * cleared by the first admitted sample; the wiring says when those happen and
 * this record says how long the hold lasts. In-memory: a restart starts at the
 * base cooldown with no instability on record.
 */
export class RestoreBackoff {
  /** The last capacity shed, by anyone. Null until one has happened. */
  lastInstabilityMs: number | null = null;

  /** When the shedding latch last released. Null until it has. */
  lastRecoveryMs: number | null = null;

  restoreCooldownMs: number = RESTORE_COOLDOWN_MS;

  /** The instability the cooldown was last bumped on, so one incident bumps it once. */
  lastRestoreCooldownBumpMs: number | null = null;

  /** Until when restores are held after this engine came up. Null when no block was ever opened. */
  startupRestoreBlockedUntilMs: number | null = null;

  noteInstability(nowMs: number): void {
    this.lastInstabilityMs = nowMs;
  }

  noteRecovery(nowMs: number): void {
    this.lastRecoveryMs = nowMs;
  }

  /** The restore pass resolved this cycle's cooldown; carry it to the next. */
  commitCooldown(cooldown: RestoreCooldownState): void {
    this.restoreCooldownMs = cooldown.restoreCooldownMs;
    this.lastRestoreCooldownBumpMs = cooldown.lastRestoreCooldownBumpMs;
  }

  /** This engine just came up: hold restores for `STARTUP_RESTORE_BLOCK_MS`. */
  beginStartupBlock(nowMs: number): void {
    this.startupRestoreBlockedUntilMs = nowMs + STARTUP_RESTORE_BLOCK_MS;
  }

  /**
   * End the startup block now. Answers whether one was ever opened — after the
   * first clear it keeps answering yes, because the stamp stays.
   *
   * Stamps the clear time rather than clearing to null on purpose: the stamp
   * has a second reader, `startupWindowEndMs`, and only a block that never
   * opened falls back.
   */
  clearStartupBlock(nowMs: number): boolean {
    if (this.startupRestoreBlockedUntilMs === null) return false;
    this.startupRestoreBlockedUntilMs = nowMs - 1;
    return true;
  }

  /**
   * When the startup window ended, for the diagnostics that label a tracked
   * transition as reconciliation rather than news. This is the block's second
   * meaning: while one is open it is the deadline, and once cleared it is the
   * moment it was cleared — which is why `clearStartupBlock` stamps rather than
   * nulls. An engine that never opened one has no such moment and takes the
   * caller's fallback.
   */
  startupWindowEndMs(fallbackMs: number): number {
    return this.startupRestoreBlockedUntilMs ?? fallbackMs;
  }

  /** How much of the startup block is left, or null when none was ever opened. */
  startupBlockRemainingMs(nowMs: number): number | null {
    return this.startupRestoreBlockedUntilMs === null
      ? null
      : Math.max(0, this.startupRestoreBlockedUntilMs - nowMs);
  }
}
