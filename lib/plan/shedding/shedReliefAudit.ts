/**
 * What a shed decision was credited, laid beside what the meter then did.
 *
 * `pendingRelief.ts` credits each shed with the relief it banked and retires
 * that credit once the whole-home reading has shown half of it: control
 * bookkeeping, tuned to stop over-shedding. This answers a different question
 * for the logs: once a decision has had time to land, how far did the
 * whole-home reading and the device's own meter actually move? One
 * `shed_relief_observed` line per decision, `SHED_RELIEF_AUDIT_HORIZON_MS`
 * after it was decided, on the first measured build at or past that point.
 *
 * A single line says little: unmanaged load moves the whole-home sum in the
 * same minute. `soleDecision` marks the lines where no other shed was decided
 * within a horizon either side and nothing was restored before the line was
 * written, so the fall can only be this device's or unrelated load. Those,
 * taken together, show whether a device's credited relief matches the meter.
 *
 * Observation only: nothing here feeds a control decision. The lone
 * switch-offs are also handed back to the caller, which records them as the
 * home meter's witness of the device's draw (`lib/ports/soleSwitchOffFalls.ts`).
 * In-memory, like the latch it reads; a restart drops the open audits.
 */
import { getLogger } from '../../logging/logger';
import type { ShedLatchDecision, ShedPlanLatch } from '../planState';
import type { PlanInputDevice } from '../planTypes';
import { isMeteredPlanDevice } from '../planMeteredDevice';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import type { SoleSwitchOffFall } from '../../ports/soleSwitchOffFalls';

const logger = getLogger('plan/shed-relief-audit');

/**
 * How long after a decision its effect is read. The pending-relief window is
 * 30 s; a floor-heating relay at one install confirmed 0 kW 10-71 s after its
 * shed (2026-11-09), so a minute lets slow devices land.
 */
export const SHED_RELIEF_AUDIT_HORIZON_MS = 60 * 1000;

/**
 * The latest a lone switch-off's fall still counts as the device's draw. Audits
 * close on measured builds only, so one opened before a silent meter or a spell
 * of simulation can close hours later, and the fall across those hours is the
 * home's, not the device's.
 */
const SOLE_FALL_MAX_AGE_MS = 2 * SHED_RELIEF_AUDIT_HORIZON_MS;

/** A metered device drawing less than this before its switch-off was not running: the fall cannot be its draw. */
const SOLE_FALL_MIN_DEVICE_DRAW_KW = 0.05;

type OpenAudit = {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly decidedAtMs: number;
  readonly reliefKind: 'electrical' | 'demand';
  creditedKw: number;
  readonly wholeHomeBeforeKw: number;
  readonly deviceDrawBeforeKw: number | null;
  /** The device was switched off, not stepped down or asked to want less: its whole draw left the home. */
  readonly switchOff: boolean;
  sole: boolean;
};

const roundKw = (kw: number): number => Math.round(kw * 1000) / 1000;

const readDrawKw = (device: PlanInputDevice | undefined): number | null => (
  device !== undefined && isMeteredPlanDevice(device) ? device.currentDrawKw : null
);

function buildObservedLine(
  audit: OpenAudit, wholeHomeKw: number, deviceDrawAfterKw: number | null, nowTs: number,
): Record<string, unknown> {
  return {
    event: 'shed_relief_observed',
    deviceId: audit.deviceId,
    deviceName: audit.deviceName,
    reliefKind: audit.reliefKind,
    creditedKw: roundKw(audit.creditedKw),
    wholeHomeBeforeKw: roundKw(audit.wholeHomeBeforeKw),
    wholeHomeAfterKw: roundKw(wholeHomeKw),
    observedFallKw: roundKw(audit.wholeHomeBeforeKw - wholeHomeKw),
    ...(audit.deviceDrawBeforeKw === null ? {} : { deviceDrawBeforeKw: roundKw(audit.deviceDrawBeforeKw) }),
    ...(deviceDrawAfterKw === null ? {} : { deviceDrawAfterKw: roundKw(deviceDrawAfterKw) }),
    elapsedMs: nowTs - audit.decidedAtMs,
    soleDecision: audit.sole,
  };
}

/** A lone switch-off whose fall the home meter showed in time, of a device that was drawing. */
const isWitnessedSwitchOff = (audit: OpenAudit, nowTs: number): boolean => (
  audit.sole
  && audit.switchOff
  && nowTs - audit.decidedAtMs <= SOLE_FALL_MAX_AGE_MS
  && (audit.deviceDrawBeforeKw === null || audit.deviceDrawBeforeKw >= SOLE_FALL_MIN_DEVICE_DRAW_KW)
);

export class ShedReliefAudit {
  private readonly open = new Map<string, OpenAudit>();
  /** When recent decisions were taken, to judge overlap for later ones. */
  private recentDecisionsAtMs: number[] = [];

  /**
   * One measured build: the latch it committed (decisions stamped `nowTs` were
   * taken now), the draw it was decided on, and the devices it restored, whose
   * rise would read as a smaller fall. Answers the lone switch-offs whose fall
   * this build read.
   */
  observe(
    latch: ShedPlanLatch | null,
    devices: readonly PlanInputDevice[],
    wholeHomeKw: number,
    restoredIds: ReadonlySet<string>,
    nowTs: number,
  ): SoleSwitchOffFall[] {
    const devicesById = new Map(devices.map((device) => [device.id, device]));
    if (restoredIds.size > 0) for (const audit of this.open.values()) audit.sole = false;
    this.openNewDecisions(latch, wholeHomeKw, devicesById, nowTs);
    const soleSwitchOffs: SoleSwitchOffFall[] = [];
    for (const [key, audit] of this.open) {
      if (nowTs - audit.decidedAtMs < SHED_RELIEF_AUDIT_HORIZON_MS) continue;
      this.open.delete(key);
      logger.info(buildObservedLine(audit, wholeHomeKw, readDrawKw(devicesById.get(audit.deviceId)), nowTs));
      if (isWitnessedSwitchOff(audit, nowTs)) {
        soleSwitchOffs.push({
          deviceId: audit.deviceId,
          decidedAtMs: audit.decidedAtMs,
          fallKw: roundKw(audit.wholeHomeBeforeKw - wholeHomeKw),
        });
      }
    }
    this.recentDecisionsAtMs = this.recentDecisionsAtMs
      .filter((atMs) => nowTs - atMs < SHED_RELIEF_AUDIT_HORIZON_MS);
    return soleSwitchOffs;
  }

  private openNewDecisions(
    latch: ShedPlanLatch | null,
    wholeHomeKw: number,
    devicesById: ReadonlyMap<string, PlanInputDevice>,
    nowTs: number,
  ): void {
    if (latch === null) return;
    for (const [deviceId, decisions] of latch.decisions) {
      for (const decision of decisions) {
        const { kind } = decision;
        if (kind === 'demand' || kind === 'electrical') {
          this.noteDecision(deviceId, decision, kind, devicesById.get(deviceId), wholeHomeKw, nowTs);
        }
      }
    }
  }

  private noteDecision(
    deviceId: string,
    decision: ShedLatchDecision,
    reliefKind: 'electrical' | 'demand',
    device: PlanInputDevice | undefined,
    wholeHomeKw: number,
    nowTs: number,
  ): void {
    const key = `${deviceId}:${decision.decidedAtMs}`;
    const existing = this.open.get(key);
    // Relief added to a device's newest decision keeps that decision's stamp.
    if (existing) {
      existing.creditedKw = Math.max(existing.creditedKw, decision.creditedKw);
      return;
    }
    // A decision is taken on a device in this build's snapshot; without it there is nothing to read.
    if (decision.decidedAtMs !== nowTs || device === undefined) return;
    const overlapping = this.recentDecisionsAtMs.length > 0 || this.open.size > 0;
    for (const audit of this.open.values()) audit.sole = false;
    this.open.set(key, {
      deviceId,
      deviceName: device.name,
      decidedAtMs: decision.decidedAtMs,
      reliefKind,
      creditedKw: decision.creditedKw,
      wholeHomeBeforeKw: wholeHomeKw,
      deviceDrawBeforeKw: readDrawKw(device),
      switchOff: reliefKind === 'electrical' && !isSteppedLoadDevice(device),
      sole: !overlapping,
    });
    this.recentDecisionsAtMs.push(nowTs);
  }
}
