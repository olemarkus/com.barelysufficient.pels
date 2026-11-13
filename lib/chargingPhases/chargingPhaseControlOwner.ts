import type {
  ChargingPhaseCount, ChargingPhaseRead, ChargingPhaseStatus,
} from '../../packages/contracts/src/chargingPhases';
import type { ChargingPhaseEnvelope } from '../../packages/planner-types/src/chargingPhases';
import type {
  ChargingPhaseActuation, ChargingPhaseDevice, ChargingPhaseOwner, ChargingPhasePlanningRead, ChargingPhaseSource,
  ChargingPhaseCommandAuthority, ChargingPhaseDecision,
  ChargingPhasePauseRecording,
} from '../ports/chargingPhases';
import type { ControlContestRecording } from '../ports/controlContest';
import type { SettingsPort } from '../ports/homeyRuntime';
import { MAIN_HOME_ID } from '../utils/settingsKeys';
import { getLogger } from '../logging/logger';
import { ChargingPhaseClaimStore, type ChargingPhaseRecord } from './phaseClaimStore';
import { ChargingPhaseCommandQueue } from './phaseCommandQueue';
import { ChargingPhasePolicyReader } from './phasePolicyReader';
import { ChargingPhasePlanningSnapshot } from './phasePlanningSnapshot';
import { CHARGING_PHASE_DRAWING_W, confirmsChargingPhases, isChargingPhaseFloor } from './phaseObservation';

const logger = getLogger('chargingPhases/control');
export const CHARGING_PHASE_CHOICE_DELAY_MS = 90_000;
export const CHARGING_PHASE_DWELL_MS = 10 * 60_000;
export const CHARGING_PHASE_CONFIRMATION_MS = 120_000;
const RELEASE_RETRY_MS = 60_000;
const MAX_SWITCHES_IN_WINDOW = 3;

type PendingSwitch = { from: ChargingPhaseCount; target: ChargingPhaseCount; issuedAtMs: number; generation: number;
  requestCompleted: boolean; wasDrawingSingleAtIssue: boolean;
  decision: Extract<ChargingPhaseDecision, { kind: 'switch' }> };
type ProposedSwitch = { target: ChargingPhaseCount; sinceMs: number; seenCycle: number };
type ReleaseAttempt = { issuedAtMs: number; requestCompleted: boolean; alreadyOriginal: boolean };
type PreparingSwitch = { target: ChargingPhaseCount; issuedAtMs: number; seenCycle: number;
  createdClaim: boolean };

/**
 * A leaf control owner. Settings retain ownership across a crash; the per-device
 * queue serializes ordinary writes, phase changes and hand-back. Reads only
 * observe state. Physical writes require an explicit admitted plan decision.
 */
export class ChargingPhaseControlOwner implements ChargingPhaseOwner {
  private readonly claims: ChargingPhaseClaimStore;
  private readonly knownRecords = new Set<string>();
  private readonly recovering = new Set<string>();
  private readonly devices = new Map<string, ChargingPhaseDevice>();
  private readonly connected = new Map<string, boolean>();
  private readonly pending = new Map<string, PendingSwitch>();
  private readonly proposals = new Map<string, ProposedSwitch>();
  private readonly preparing = new Map<string, PreparingSwitch>();
  private readonly commands = new ChargingPhaseCommandQueue();
  private readonly cancelledUntilMs = new Map<string, number>();
  private readonly lastIntents = new Map<string, ChargingPhaseCount | 'release'>();
  private readonly desired = new Map<string, boolean>();
  private readonly failed = new Set<string>();
  private readonly releaseAttempts = new Map<string, ReleaseAttempt>();
  private readonly releasedCycle = new Map<string, number>();
  private readonly policyReader: ChargingPhasePolicyReader;
  private permittedEnvelopes: ReadonlyMap<string, readonly ChargingPhaseEnvelope[]> = new Map();
  private cycle = 0;
  private nowMs = 0;

  constructor(
    settings: SettingsPort,
    private readonly source: ChargingPhaseSource,
    private readonly actuation: ChargingPhaseActuation,
    private readonly contest: ControlContestRecording,
    private readonly pauses: ChargingPhasePauseRecording,
  ) {
    this.claims = new ChargingPhaseClaimStore(settings);
    this.policyReader = new ChargingPhasePolicyReader(settings, (id, nowMs) => this.invalidate(id, nowMs));
  }

  public readPlanning(nowMs: number): ChargingPhasePlanningRead {
    this.nowMs = nowMs;
    this.cycle += 1;
    this.refreshPolicy();
    this.refreshClaims();
    this.refreshDevices(nowMs);
    const read = new ChargingPhasePlanningSnapshot();
    for (const device of this.devices.values()) this.projectDevice(device, read, nowMs);
    // A missing or unavailable device still owes its durable hand-back.
    for (const [id, record] of this.claims.entries()) {
      if (record.kind !== 'held' || this.devices.has(id)) continue;
      read.reservations.push({ deviceId: id, ...record.reservation });
      read.releases.push({ kind: 'release', deviceId: id });
    }
    this.permittedEnvelopes = read.permittedEnvelopes;
    return read;
  }

  private projectDevice(device: ChargingPhaseDevice, read: ChargingPhasePlanningSnapshot, nowMs: number): void {
    const id = device.deviceId;
    const phases = device.planningPhases;
    const observed = this.source.observedPoint(device, phases);
    read.observations.push({ deviceId: id, ...observed });
    const record = this.claims.read(id);
    if (record?.kind === 'held') {
      read.reservations.push({ deviceId: id, ...record.reservation });
      if (this.needsRelease(device)) read.releases.push({ kind: 'release', deviceId: id });
    }
    const pending = this.pending.get(id);
    if (pending && !this.needsRelease(device)) read.continuations.push(pending.decision);
    const configured = this.policy[id];
    if (!configured || !this.eligible(device)) return;
    const envelopes = this.source.envelopes(device);
    if (envelopes.length !== 2) return;
    read.permittedEnvelopes.set(id, this.permittedFor(device, phases, envelopes));
    if (this.candidateReady(device, nowMs)) read.candidates.push({ deviceId: id, mode: configured.mode, observed,
      forceSinglePhase: device.forceSinglePhase,
      envelopes, minimumCurrentA: device.minimumCurrentA });
  }

  public readPermittedEnvelopes(): ReadonlyMap<string, readonly ChargingPhaseEnvelope[]> {
    return this.permittedEnvelopes;
  }

  public read(deviceId: string): ChargingPhaseRead {
    this.refreshClaims();
    if (!this.claims.canClaim(deviceId) && !this.devices.has(deviceId)) {
      const device = this.source.readDevices().find((entry) => entry.deviceId === deviceId);
      if (device) this.devices.set(deviceId, device);
    }
    if (!this.devices.has(deviceId) && this.claims.read(deviceId) === undefined) return { kind: 'unsupported' };
    const settings = this.policy[deviceId];
    return { kind: 'supported', deviceId, mode: settings?.mode ?? 'charger',
      installationConfirmed: settings?.installationConfirmed === true, status: this.status(deviceId) };
  }

  public blocksIncrease(deviceId: string): boolean {
    this.refreshClaims();
    if (!this.claims.canClaim(deviceId)) return true;
    return this.releasedCycle.get(deviceId) === this.cycle || this.pending.has(deviceId)
      || this.preparing.has(deviceId) || this.recovering.has(deviceId) || this.releaseAttempts.has(deviceId)
      || (this.claims.read(deviceId)?.kind === 'held'
        && (this.failed.has(deviceId) || this.needsRelease(this.devices.get(deviceId))));
  }

  public getDesiredForceSingle(deviceId: string): boolean | null {
    if (this.recovering.has(deviceId) || this.releaseAttempts.has(deviceId)) return null;
    return this.desired.get(deviceId) ?? null;
  }

  public cancelForSafety(deviceId: string): void { this.invalidate(deviceId, Date.now()); }

  public reconcilePlan(decisions: readonly ChargingPhaseDecision[], nowMs: number): void {
    this.nowMs = nowMs;
    const next = new Map(decisions.map((decision) => [decision.deviceId,
      decision.kind === 'release' ? 'release' as const : decision.target.phases]));
    for (const [id, intent] of this.lastIntents) {
      if (next.get(id) !== intent && this.hasInFlightIntent(id)) this.invalidate(id, nowMs);
    }
    this.lastIntents.clear();
    for (const [id, intent] of next) this.lastIntents.set(id, intent);
    for (const decision of decisions) {
      const preparation = this.preparing.get(decision.deviceId);
      if (preparation && decision.kind !== 'release' && decision.target.phases === preparation.target) {
        this.preparing.set(decision.deviceId, { ...preparation, seenCycle: this.cycle });
      }
    }
  }

  public runDeviceCommand<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    return this.commands.run(deviceId, operation);
  }

  public apply(decision: ChargingPhaseDecision, nowMs: number): Promise<{ requested: boolean }> {
    const generation = this.generation(decision.deviceId);
    return this.runDeviceCommand(decision.deviceId, async () => {
      if (generation !== this.generation(decision.deviceId)) return { requested: false };
      if (decision.kind === 'release') return this.release(decision.deviceId, nowMs, generation);
      if (decision.kind === 'prepare') return this.prepare(decision, nowMs, generation);
      return this.switch(decision, nowMs, generation);
    });
  }

  private get policy() { return this.policyReader.values; }
  private get policyAvailable(): boolean { return this.policyReader.available; }
  private refreshPolicy(): void { this.policyReader.refresh(this.nowMs); }

  private refreshClaims(): void {
    if (!this.claims.load()) return;
    for (const [id, record] of this.claims.entries()) {
      if (this.knownRecords.has(id)) continue;
      this.knownRecords.add(id);
      if (record.kind === 'held') this.recovering.add(id);
    }
  }

  private refreshDevices(nowMs: number): void {
    for (const device of this.source.readDevices()) {
      const id = device.deviceId;
      this.devices.set(id, device);
      this.contest.controlReported({ deviceId: id, setting: 'charging_phases', value: device.forceSinglePhase,
        reportedAtMs: device.forceSinglePhaseObservedAtMs });
      this.observeConnection(device);
      const proposal = this.proposals.get(id);
      if (proposal && proposal.seenCycle < this.cycle - 1) this.proposals.delete(id);
      const preparation = this.preparing.get(id);
      if (preparation && (preparation.seenCycle < this.cycle - 1
        || nowMs - preparation.issuedAtMs >= CHARGING_PHASE_CONFIRMATION_MS)) this.invalidate(id, nowMs);
      this.syncPending(device, nowMs);
      this.syncRelease(device);
    }
  }

  private observeConnection(device: ChargingPhaseDevice): void {
    const id = device.deviceId;
    if (!device.connected && this.connected.get(id) === true) {
      this.commands.invalidate(id);
      this.failed.delete(id);
      this.proposals.delete(id);
      this.preparing.delete(id);
      this.cancelledUntilMs.delete(id);
      if (this.claims.read(id)?.kind === 'held') this.recovering.add(id);
    }
    this.connected.set(id, device.connected);
    if (!device.available && this.claims.read(id)?.kind === 'held') this.recovering.add(id);
  }

  private syncPending(device: ChargingPhaseDevice, nowMs: number): void {
    const pending = this.pending.get(device.deviceId);
    if (!pending) return;
    if (pending.generation !== this.generation(device.deviceId)) return;
    if (pending.requestCompleted && this.confirmsPending(device, pending)) {
      if (!this.claims.clearReservation(device.deviceId)) return;
      this.pending.delete(device.deviceId);
      this.lastIntents.delete(device.deviceId);
      logger.info({ event: 'charging_phase_confirmed', deviceId: device.deviceId, phases: pending.target });
    } else if (nowMs - pending.issuedAtMs >= CHARGING_PHASE_CONFIRMATION_MS) {
      this.failed.add(device.deviceId);
      this.invalidate(device.deviceId, nowMs);
      this.pending.delete(device.deviceId);
      logger.warn({ event: 'charging_phase_not_confirmed', deviceId: device.deviceId, phases: pending.target });
    }
  }

  private confirmsPending(device: ChargingPhaseDevice, pending: PendingSwitch): boolean {
    const retainedSingle = pending.target === 1 && pending.wasDrawingSingleAtIssue
      && device.drawingPhases === 1 && device.forceSinglePhase;
    return retainedSingle || confirmsChargingPhases(device, pending.target, pending.issuedAtMs);
  }

  private syncRelease(device: ChargingPhaseDevice): void {
    const attempt = this.releaseAttempts.get(device.deviceId);
    const record = this.claims.read(device.deviceId);
    if (!attempt?.requestCompleted || record?.kind !== 'held'
      || device.forceSinglePhase !== record.originalForceSingle) return;
    // Returning to unrestricted phases is done paused by transport. Its new
    // independent zero power, rather than the optimistic setting echo, ends
    // the transition reservation. A contraction can also complete while drawing.
    const paused = device.totalPower.watts <= CHARGING_PHASE_DRAWING_W;
    const contracted = record.originalForceSingle && confirmsChargingPhases(device, 1, attempt.issuedAtMs);
    if (!paused && !contracted && !attempt.alreadyOriginal) return;
    const released = this.claims.persistLifecycle(device.deviceId, () => {
      this.source.releasePlanningEnvelope(device.deviceId, record.originalForceSingle);
      this.claims.write(device.deviceId, { kind: 'free', switchesMs: record.switchesMs });
    });
    if (!released) return;
    this.recovering.delete(device.deviceId);
    this.releaseAttempts.delete(device.deviceId);
    this.pending.delete(device.deviceId);
    this.preparing.delete(device.deviceId);
    this.desired.delete(device.deviceId);
    this.lastIntents.delete(device.deviceId);
    this.releasedCycle.set(device.deviceId, this.cycle);
    this.contest.commandReleased(device.deviceId, 'charging_phases');
    logger.info({ event: 'charging_phase_released', deviceId: device.deviceId });
  }

  private eligible(device: ChargingPhaseDevice): boolean {
    return device.available && device.connected && device.managed
      && device.controlEnabled && !this.source.isSimulation();
  }

  private needsRelease(device: ChargingPhaseDevice | undefined): boolean {
    if (!device) return true;
    return this.recovering.has(device.deviceId) || this.failed.has(device.deviceId)
      || this.policy[device.deviceId] === undefined || !device.managed
      || !device.controlEnabled || this.source.isSimulation()
      || this.source.envelopes(device).length !== 2;
  }

  private switchWindowOpen(deviceId: string, nowMs: number): boolean {
    const history = this.claims.read(deviceId)?.switchesMs ?? [];
    const recent = history.filter((at) => nowMs - at < CHARGING_PHASE_DWELL_MS);
    const last = history.at(-1);
    return recent.length < MAX_SWITCHES_IN_WINDOW && (last === undefined || nowMs - last >= CHARGING_PHASE_DWELL_MS);
  }

  private permittedFor(
    device: ChargingPhaseDevice, phases: ChargingPhaseCount, envelopes: readonly ChargingPhaseEnvelope[],
  ): readonly ChargingPhaseEnvelope[] {
    if (this.failed.has(device.deviceId)) return envelopes.filter((envelope) => envelope.phases === phases);
    const configured = this.policy[device.deviceId];
    if (!configured) return [];
    return envelopes.filter((envelope) => configured.mode === 'automatic'
      || envelope.phases === (configured.mode === 'single' ? 1 : 3));
  }

  private candidateReady(device: ChargingPhaseDevice, nowMs: number): boolean {
    const id = device.deviceId;
    return !this.pending.has(id) && !this.failed.has(id) && !this.needsRelease(device)
      && this.policyAvailable && this.claims.canClaim(id) && this.switchWindowOpen(id, nowMs)
      && nowMs >= (this.cancelledUntilMs.get(id) ?? 0);
  }

  private canDispatchSwitch(
    device: ChargingPhaseDevice, decision: Extract<ChargingPhaseDecision, { kind: 'switch' }>, nowMs: number,
  ): boolean {
    return this.policyAvailable && this.eligible(device) && !this.pending.has(device.deviceId)
      && !this.failed.has(device.deviceId) && !this.needsRelease(device) && !this.releaseAttempts.has(device.deviceId)
      && this.claims.canClaim(device.deviceId) && this.switchWindowOpen(device.deviceId, nowMs)
      && isChargingPhaseFloor(device, this.source.envelopes(device))
      && decision.target.currentA <= device.minimumCurrentA;
  }

  private generation(deviceId: string): number { return this.commands.generation(deviceId); }

  private invalidate(deviceId: string, nowMs: number): void {
    const unknownPhase = this.pending.has(deviceId) || this.releaseAttempts.has(deviceId);
    const preparation = this.preparing.get(deviceId);
    this.commands.invalidate(deviceId);
    this.proposals.delete(deviceId);
    this.preparing.delete(deviceId);
    this.releaseAttempts.delete(deviceId);
    this.cancelledUntilMs.set(deviceId, nowMs + CHARGING_PHASE_CHOICE_DELAY_MS);
    const record = this.claims.read(deviceId);
    if (record?.kind !== 'held') return;
    if (unknownPhase) this.recovering.add(deviceId);
    else if (preparation?.createdClaim) {
      if (!this.claims.persistLifecycle(deviceId,
        () => this.claims.write(deviceId, { kind: 'free', switchesMs: record.switchesMs }))) {
        this.recovering.add(deviceId);
      }
    } else if (preparation && !this.claims.clearReservation(deviceId)) this.recovering.add(deviceId);
  }

  private hasInFlightIntent(deviceId: string): boolean {
    return this.pending.has(deviceId) || this.preparing.has(deviceId) || this.proposals.has(deviceId)
      || this.commands.hasWork(deviceId) || this.releaseAttempts.has(deviceId);
  }

  private authority(
    deviceId: string, generation: number, kind: ChargingPhaseDecision['kind'],
  ): ChargingPhaseCommandAuthority {
    const admittedDevice = this.source.readDevices().find((entry) => entry.deviceId === deviceId);
    const admittedEnvelopes = admittedDevice ? JSON.stringify(this.source.envelopes(admittedDevice)) : '';
    return { isCurrent: () => {
      this.refreshPolicy();
      if (generation !== this.generation(deviceId)) return false;
      const device = this.source.readDevices().find((entry) => entry.deviceId === deviceId);
      if (!device?.available) return false;
      if (kind === 'release') return true;
      if (this.policyAvailable && this.policy[deviceId] && this.eligible(device)
        && this.source.envelopes(device).length === 2
        && JSON.stringify(this.source.envelopes(device)) === admittedEnvelopes
        && (kind !== 'switch' || isChargingPhaseFloor(device, this.source.envelopes(device)))) return true;
      this.invalidate(deviceId, this.nowMs);
      return false;
    } };
  }

  private createClaim(
    decision: Exclude<ChargingPhaseDecision, { kind: 'release' }>, device: ChargingPhaseDevice, nowMs: number,
  ): Extract<ChargingPhaseRecord, { kind: 'held' }> {
    const previous = this.claims.read(device.deviceId);
    return {
      kind: 'held',
      originalForceSingle: previous?.kind === 'held' ? previous.originalForceSingle : device.forceSinglePhase,
      claimedAtMs: previous?.kind === 'held' ? previous.claimedAtMs : nowMs,
      switchesMs: previous?.switchesMs ?? [],
      reservation: { totalKw: decision.reservation.totalKw, perPhaseKw: decision.reservation.perPhaseKw },
    };
  }

  private saveClaim(deviceId: string, record: ChargingPhaseRecord): void {
    this.claims.write(deviceId, record);
    this.knownRecords.add(deviceId);
  }

  private async prepare(
    decision: Extract<ChargingPhaseDecision, { kind: 'prepare' }>, nowMs: number, generation: number,
  ): Promise<{ requested: boolean }> {
    const authority = this.authority(decision.deviceId, generation, 'prepare');
    if (!authority.isCurrent()) return { requested: false };
    const device = this.source.readDevices().find((entry) => entry.deviceId === decision.deviceId);
    if (!device || !this.canPrepare(device, decision)) return { requested: false };
    const previous = this.preparing.get(device.deviceId);
    if (previous) {
      this.preparing.set(device.deviceId, { ...previous, seenCycle: this.cycle });
      return { requested: false };
    }
    if (this.policy[device.deviceId]?.mode === 'automatic'
      && !this.qualifiesProposal(device.deviceId, decision.target.phases, nowMs)) return { requested: false };
    const issuedAtMs = Date.now();
    const createdClaim = this.claims.read(device.deviceId)?.kind !== 'held';
    this.saveClaim(device.deviceId, this.createClaim(decision, device, issuedAtMs));
    this.preparing.set(device.deviceId, { target: decision.target.phases, issuedAtMs,
      seenCycle: this.cycle, createdClaim });
    try {
      const result = await this.actuation.apply({ kind: 'charging_phase_prepare', deviceId: device.deviceId,
        currentA: decision.target.currentA, authority });
      if (generation !== this.generation(device.deviceId)) return result;
      if (result.requested) this.contest.commandSent({ homeId: MAIN_HOME_ID, deviceId: device.deviceId,
        deviceName: device.deviceId, setting: 'level', value: `${decision.target.currentA}a`, atMs: issuedAtMs });
      else this.invalidate(device.deviceId, nowMs);
      return result;
    } catch (error) {
      if (generation === this.generation(device.deviceId)) this.invalidate(device.deviceId, nowMs);
      throw error;
    }
  }

  private canPrepare(
    device: ChargingPhaseDevice, decision: Extract<ChargingPhaseDecision, { kind: 'prepare' }>,
  ): boolean {
    if (this.pending.has(device.deviceId) || this.failed.has(device.deviceId)
      || this.needsRelease(device) || !this.claims.canClaim(device.deviceId)) return false;
    const configured = this.policy[device.deviceId];
    if (!configured || decision.target.currentA !== device.minimumCurrentA) return false;
    return configured.mode === 'automatic'
      || decision.target.phases === (configured.mode === 'single' ? 1 : 3);
  }

  private async switch(
    decision: Extract<ChargingPhaseDecision, { kind: 'switch' }>, nowMs: number, generation: number,
  ): Promise<{ requested: boolean }> {
    this.refreshPolicy();
    const device = this.source.readDevices().find((candidate) => candidate.deviceId === decision.deviceId);
    const configured = this.policy[decision.deviceId];
    const preparation = this.preparing.get(decision.deviceId);
    if (preparation) this.preparing.set(decision.deviceId, { ...preparation, seenCycle: this.cycle });
    if (!device || !configured || !this.canDispatchSwitch(device, decision, nowMs)) return { requested: false };
    const authority = this.authority(decision.deviceId, generation, 'switch');
    if (!authority.isCurrent()) return { requested: false };
    if (configured.mode !== 'automatic'
      && decision.target.phases !== (configured.mode === 'single' ? 1 : 3)) return { requested: false };
    if (device.forceSinglePhase === (decision.target.phases === 1)) return { requested: false };
    if (configured.mode === 'automatic' && !preparation
      && !this.qualifiesProposal(device.deviceId, decision.target.phases, nowMs)) {
      return { requested: false };
    }
    return this.sendSwitch(this.beginSwitch(decision, device, generation), authority);
  }

  private beginSwitch(
    decision: Extract<ChargingPhaseDecision, { kind: 'switch' }>, device: ChargingPhaseDevice, generation: number,
  ): PendingSwitch {
    const issuedAtMs = Date.now();
    const record = this.createClaim(decision, device, issuedAtMs);
    const switchesMs = [...record.switchesMs.filter((at) => issuedAtMs - at < CHARGING_PHASE_DWELL_MS), issuedAtMs];
    this.saveClaim(device.deviceId, { ...record, switchesMs });
    const pending: PendingSwitch = { from: device.planningPhases, target: decision.target.phases, issuedAtMs,
      generation, decision, requestCompleted: false, wasDrawingSingleAtIssue: device.drawingPhases === 1 };
    this.pending.set(device.deviceId, pending);
    this.preparing.delete(device.deviceId);
    this.proposals.delete(device.deviceId);
    return pending;
  }

  private async sendSwitch(
    pending: PendingSwitch, authority: ChargingPhaseCommandAuthority,
  ): Promise<{ requested: boolean }> {
    const { decision, generation, issuedAtMs } = pending;
    const { deviceId } = decision;
    try {
      const result = await this.actuation.apply({ kind: 'charging_phase', deviceId,
        phases: decision.target.phases, currentA: decision.target.currentA, authority });
      if (generation !== this.generation(deviceId)) return result;
      if (!result.requested) this.failed.add(deviceId);
      if (result.requested) {
        const current = this.pending.get(deviceId);
        if (current) this.pending.set(deviceId, { ...current, requestCompleted: true });
        this.desired.set(deviceId, decision.target.phases === 1);
        this.contest.commandSent({ homeId: MAIN_HOME_ID, deviceId, deviceName: deviceId,
          setting: 'charging_phases', value: decision.target.phases === 1, atMs: issuedAtMs });
      }
      logger.info({ event: 'charging_phase_requested', deviceId,
        phases: decision.target.phases, currentA: decision.target.currentA, requested: result.requested });
      return result;
    } catch (error) {
      // A failed request can still have reached the device. Keep its reservation
      // and restore obligation until a later decided release converges.
      if (generation === this.generation(deviceId)) this.failed.add(deviceId);
      logger.warn({ event: 'charging_phase_request_failed', deviceId, err: error });
      throw error;
    }
  }

  private qualifiesProposal(deviceId: string, target: ChargingPhaseCount, nowMs: number): boolean {
    const previous = this.proposals.get(deviceId);
    if (!previous || previous.target !== target) {
      this.proposals.set(deviceId, { target, sinceMs: nowMs, seenCycle: this.cycle });
      return false;
    }
    this.proposals.set(deviceId, { ...previous, seenCycle: this.cycle });
    return nowMs - previous.sinceMs >= CHARGING_PHASE_CHOICE_DELAY_MS;
  }

  private async release(deviceId: string, nowMs: number, generation: number): Promise<{ requested: boolean }> {
    const record = this.claims.read(deviceId);
    if (record?.kind !== 'held') return { requested: false };
    const device = this.source.readDevices().find((candidate) => candidate.deviceId === deviceId);
    if (!device?.available) return { requested: false };
    const prior = this.releaseAttempts.get(deviceId);
    if (prior && nowMs - prior.issuedAtMs < RELEASE_RETRY_MS) return { requested: false };
    const alreadyOriginal = device.forceSinglePhase === record.originalForceSingle;
    this.releaseAttempts.set(deviceId, { issuedAtMs: nowMs, requestCompleted: false, alreadyOriginal });
    const result = await this.actuation.apply({ kind: 'charging_phase_release', deviceId,
      forceSinglePhase: record.originalForceSingle, authority: this.authority(deviceId, generation, 'release'),
      pauseLifecycle: this.pauses.forDevice(deviceId) });
    if (generation !== this.generation(deviceId)) return result;
    this.releaseAttempts.set(deviceId, { issuedAtMs: nowMs, requestCompleted: result.requested, alreadyOriginal });
    return result;
  }

  private status(deviceId: string): ChargingPhaseStatus {
    const device = this.devices.get(deviceId);
    if (!this.claims.canClaim(deviceId)) return { kind: 'failed',
      reason: 'Phase control recovery could not be loaded.' };
    if (this.recovering.has(deviceId) || this.releaseAttempts.has(deviceId)) return { kind: 'releasing' };
    if (this.failed.has(deviceId)) return { kind: 'failed',
      reason: 'Phase switching could not be confirmed. It will be tried again after the car reconnects.' };
    const pending = this.pending.get(deviceId);
    if (pending) return { kind: 'switching', from: pending.from, to: pending.target };
    const preparing = this.preparing.get(deviceId);
    if (preparing && device) return { kind: 'preparing', from: device.planningPhases,
      to: preparing.target };
    if (!device || this.policy[deviceId] === undefined) return { kind: 'charger' };
    return this.settledStatus(device);
  }

  private settledStatus(device: ChargingPhaseDevice): ChargingPhaseStatus {
    const deviceId = device.deviceId;
    const phases = device.planningPhases;
    const proposal = this.proposals.get(deviceId);
    const history = this.claims.read(deviceId)?.switchesMs ?? [];
    if (proposal) return { kind: 'waiting', phases, untilMs: proposal.sinceMs + CHARGING_PHASE_CHOICE_DELAY_MS };
    const lastSwitch = history.at(-1);
    if (lastSwitch !== undefined && lastSwitch + CHARGING_PHASE_DWELL_MS > this.nowMs) {
      return { kind: 'waiting', phases, untilMs: lastSwitch + CHARGING_PHASE_DWELL_MS };
    }
    return { kind: 'ready', phases };
  }
}
