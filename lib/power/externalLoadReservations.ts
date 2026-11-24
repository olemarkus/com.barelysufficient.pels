import { POWER_SAMPLE_STALE_THRESHOLD_MS } from './sampleFreshness';
import { resolveSuspectSinceMs } from './heldReading';
import type { PowerTrackerState } from './trackerTypes';

const MAX_LOAD_NAME_LENGTH = 80;
const MAX_LOAD_POWER_W = 100_000;
const MAX_RESERVATION_MINUTES = 1_440;
const MAX_RESERVATIONS = 32;

export type ExternalLoadReservation = {
  readonly name: string;
  readonly powerW: number;
  readonly untilMs: number;
};

export type ExternalLoadReservationSnapshot = {
  readonly revision: number;
  readonly committedKw: number;
};

/** A plan that left all active external loads room on the admitted meter sample. */
export type ExternalLoadReadyEvidence = {
  readonly reservationRevision: number;
  readonly sampledAtMs: number;
  readonly phaseEvidence: { kind: 'not_required' } | { kind: 'observed'; sampledAtMs: number };
};

export type ExternalLoadReservationDecision =
  | { kind: 'waiting'; reservationRevision: number }
  | ({ kind: 'ready' } & ExternalLoadReadyEvidence);

function readExternalLoadName(raw: string): string {
  const name = raw.trim();
  if (name === '' || name.length > MAX_LOAD_NAME_LENGTH) {
    throw new Error('Choose a load name of 1 to 80 characters.');
  }
  return name;
}

function isAcceptedSample(tracker: PowerTrackerState, sampledAtMs: number): boolean {
  return tracker.lastTimestamp === sampledAtMs && resolveSuspectSinceMs(tracker) === null;
}

/** Main-home requests, effective only after an admitted whole-home sample. */
export class ExternalLoadReservations {
  private readonly requested = new Map<string, ExternalLoadReservation>();

  private active: readonly ExternalLoadReservation[] = [];

  private snapshot: ExternalLoadReservationSnapshot = { revision: 0, committedKw: 0 };

  private readonly announced = new Set<ExternalLoadReservation>();

  private requestedAtMs = -Infinity;

  private ready: (reservation: ExternalLoadReservation) => void = () => {};

  reserve(rawName: string, powerW: number | null, minutes: number | null, nowMs: number): void {
    const name = readExternalLoadName(rawName);
    if (powerW === null || !Number.isInteger(powerW) || powerW < 1 || powerW > MAX_LOAD_POWER_W) {
      throw new Error('Choose a power from 1 to 100000 watts.');
    }
    if (minutes === null || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_RESERVATION_MINUTES) {
      throw new Error('Choose a duration from 1 to 1440 minutes.');
    }
    if (this.requested.size >= MAX_RESERVATIONS && !this.requested.has(name)) {
      throw new Error('There are already 32 capacity reservations.');
    }
    this.requested.set(name, { name, powerW, untilMs: nowMs + minutes * 60_000 });
    this.requestedAtMs = nowMs;
  }

  release(rawName: string, nowMs: number): void {
    if (this.requested.delete(readExternalLoadName(rawName))) this.requestedAtMs = nowMs;
  }

  /** Update the planner input at the meter boundary. */
  admitSample(tracker: PowerTrackerState, sampledAtMs: number): void {
    if (!isAcceptedSample(tracker, sampledAtMs)) return;
    if (sampledAtMs <= this.requestedAtMs) return;
    for (const [name, reservation] of this.requested) {
      if (reservation.untilMs <= sampledAtMs) this.requested.delete(name);
    }
    const active = [...this.requested.values()];
    if (active.length === this.active.length && active.every((entry, index) => entry === this.active[index])) {
      return;
    }
    this.active = active;
    for (const entry of this.announced) {
      if (this.requested.get(entry.name) !== entry) this.announced.delete(entry);
    }
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      committedKw: active.reduce((sum, reservation) => sum + reservation.powerW, 0) / 1000,
    };
  }

  current(): ExternalLoadReservationSnapshot {
    return this.snapshot;
  }

  controlLimitKw(limitKw: number | null): number | null {
    return limitKw === null ? null : limitKw - this.snapshot.committedKw;
  }

  needsDecision(decision: ExternalLoadReservationDecision | undefined): boolean {
    return this.snapshot.revision !== (decision?.reservationRevision ?? 0);
  }

  onReady(listener: (reservation: ExternalLoadReservation) => void): void {
    this.ready = listener;
  }

  confirmReadyForSample(
    decision: ExternalLoadReservationDecision | undefined,
    tracker: PowerTrackerState,
    sampledAtMs: number,
    nowMs: number,
  ): void {
    if (decision?.kind !== 'ready' || decision.sampledAtMs !== sampledAtMs
      || !isAcceptedSample(tracker, sampledAtMs)) return;
    this.confirmReady(decision, nowMs);
  }

  private confirmReady(evidence: ExternalLoadReadyEvidence, nowMs: number): void {
    if (evidence.reservationRevision !== this.snapshot.revision || evidence.sampledAtMs <= this.requestedAtMs
      || nowMs - evidence.sampledAtMs > POWER_SAMPLE_STALE_THRESHOLD_MS) return;
    if (evidence.phaseEvidence.kind === 'observed') {
      const phaseSampleMs = evidence.phaseEvidence.sampledAtMs;
      if (phaseSampleMs <= this.requestedAtMs
        || Math.abs(evidence.sampledAtMs - phaseSampleMs) > POWER_SAMPLE_STALE_THRESHOLD_MS) return;
    }
    for (const reservation of this.active) {
      if (reservation.untilMs <= nowMs || this.announced.has(reservation)) continue;
      this.announced.add(reservation);
      this.ready(reservation);
    }
  }
}
