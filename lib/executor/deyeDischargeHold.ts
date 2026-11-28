import { createHash } from 'node:crypto';
import type { DeyeDischargeHoldStatus } from '../../packages/contracts/src/deyeDischargeHold';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { DeyeCloudClient, DeyeCloudCredentials } from '../actuator/deyeCloudClient';
import { getLogger } from '../logging/logger';
import type { EvDischargeHoldLane } from '../ports/evDischargeHold';
import { ApiRequestError } from '../utils/apiRequestError';
import {
  DEYE_DISCHARGE_HOLD_KEY, deyeRegion, deyeText, readDeyeHoldRecord,
  type DeyeClaim, type DeyeHoldRecord, type DeyeHoldSettings,
} from './deyeDischargeHoldRecord';

const POLL_MS = 60_000;
const RECOVERY_NOTICE_MS = 15 * POLL_MS;
const log = getLogger('deyeDischargeHold');

function parseSetup(input: unknown): DeyeCloudCredentials {
  if (!isUnknownRecord(input) || input.acknowledgeRisk !== true) {
    throw new ApiRequestError('Confirm that you can restore the inverter’s discharge limit in Deye Cloud.');
  }
  const region = deyeRegion(input.region);
  const appId = deyeText(input.appId);
  const appSecret = deyeText(input.appSecret);
  const email = deyeText(input.email);
  const deviceSn = deyeText(input.deviceSn);
  const { password } = input;
  if (!region || !appId || !appSecret || !email || !deviceSn || typeof password !== 'string'
    || password.length === 0 || password.length > 512) {
    throw new ApiRequestError('Enter the Deye Cloud account, developer credentials and inverter serial number.');
  }
  // Deye's token endpoint requires SHA-256 hex as its password field.
  // The result is a reusable API credential, kept private like the app secret.
  const passwordHash = createHash('sha256').update(password).digest('hex');
  return { region, appId, appSecret, email, deviceSn, passwordHash };
}

type DeyeDischargeActuator = Pick<DeyeCloudClient, 'readLimit' | 'prepareLimitWrite' | 'readOrder'>;

/**
 * Owns the original inverter limit and the single cloud order in flight.
 * A submitting record can survive a lost response. Only the owner can resolve it manually.
 */
export class DeyeDischargeHold implements EvDischargeHoldLane {
  private enabled = false;
  private desiredHold = false;
  private canHold = () => false;
  private queue = Promise.resolve();
  private queued = 0;
  private timer?: ReturnType<typeof setInterval>;
  private recoverOnStart = true;
  private submitting = false;
  private disabling = 0;
  private holdFailed = false;
  private unavailable = false;
  private retryAfterMs = 0;
  private record: DeyeHoldRecord | null | undefined;

  constructor(private readonly settings: DeyeHoldSettings, private readonly cloud: DeyeDischargeActuator) {}

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.recoverOnStart = true;
    this.record = readDeyeHoldRecord(this.settings);
    this.timer = setInterval(() => { if (this.read()?.claim) this.kick(); }, POLL_MS);
    this.timer.unref();
    // A hold from an earlier runtime is owed a release, even before the first live meter plan.
    this.kick();
  }

  stop(): void {
    this.enabled = false;
    this.desiredHold = false;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  hasWork(hold: boolean): boolean {
    const { record } = this;
    if (!record?.enabled) return false;
    return hold !== this.desiredHold || (hold && !record.claim && !this.holdFailed && Date.now() >= this.retryAfterMs);
  }

  apply(hold: boolean, canHold: () => boolean): void {
    this.desiredHold = hold;
    this.canHold = canHold;
    if (!hold) this.holdFailed = false;
    const { record } = this;
    if (!record) return;
    if (!record.claim || (!hold && record.claim.releaseRequestedAtMs === undefined)) this.kick();
  }

  status(): DeyeDischargeHoldStatus {
    const record = this.read();
    if (record === undefined) return { enabled: false, state: 'recovery_required' };
    if (!record) return { enabled: false, state: 'disabled' };
    const { enabled, claim } = record;
    const step = claim?.step;
    return {
      enabled, state: this.holdState(record), deviceSn: record.credentials.deviceSn, region: record.credentials.region,
      ...(claim ? { originalLimitA: claim.originalLimitA } : {}),
      ...(step?.kind === 'order' || step?.kind === 'readback' ? { orderId: step.orderId } : {}),
    };
  }

  private holdState({ claim, enabled }: DeyeHoldRecord): DeyeDischargeHoldStatus['state'] {
    if (this.needsManualRecovery(claim)) return 'recovery_required';
    if (this.unavailable || this.holdFailed) return 'unavailable';
    if (claim?.step.kind === 'held' && claim.releaseRequestedAtMs === undefined) return 'held';
    if (claim) return 'pending';
    return enabled ? 'ready' : 'disabled';
  }

  async save(input: unknown): Promise<DeyeDischargeHoldStatus> {
    const credentials = parseSetup(input);
    return this.serial(async () => {
      const record = this.read();
      if (record === undefined) throw new ApiRequestError('PELS could not read the saved Deye recovery record.');
      if (record?.claim && (credentials.deviceSn !== record.credentials.deviceSn
        || credentials.region !== record.credentials.region)) {
        throw new ApiRequestError('Use the same inverter serial number and region until you restore the limit.');
      }
      try {
        await this.cloud.readLimit(credentials);
      } catch {
        throw new ApiRequestError(
          'PELS could not read the discharge limit. Check the Deye Cloud account and inverter serial number.',
        );
      }
      if (record?.claim) {
        this.desiredHold = false;
        this.persist({ enabled: false, credentials, claim: this.requestRelease(record.claim) });
      } else {
        this.persist({ enabled: true, credentials });
      }
      this.unavailable = false;
      this.holdFailed = false;
      return this.status();
    }).finally(() => { if (this.read()?.claim) this.kick(); });
  }

  disable(): Promise<DeyeDischargeHoldStatus> {
    this.desiredHold = false;
    this.disabling += 1;
    return this.serial(async () => {
      const record = this.read();
      if (record === undefined) throw new ApiRequestError('PELS could not read the saved Deye recovery record.');
      if (record?.claim) {
        this.persist({ ...record, enabled: false, claim: this.requestRelease(record.claim) });
      } else if (record) {
        this.persist(null);
      }
      return this.status();
    }).finally(() => {
      this.disabling -= 1;
      this.kick();
    });
  }

  async acknowledge(input: unknown): Promise<DeyeDischargeHoldStatus> {
    if (!isUnknownRecord(input) || input.confirmedOrderSettled !== true) {
      throw new ApiRequestError('Confirm that the Deye command has finished and the original limit has been restored.');
    }
    return this.serial(async () => {
      const record = this.read();
      if (!record?.claim || !this.needsManualRecovery(record.claim)) {
        throw new ApiRequestError('PELS has no Deye hold awaiting manual recovery.');
      }
      let amps: number;
      try {
        amps = await this.cloud.readLimit(record.credentials);
      } catch {
        throw new ApiRequestError('PELS could not check the restored discharge limit in Deye Cloud.');
      }
      if (amps !== record.claim.originalLimitA) {
        throw new ApiRequestError('The inverter still reports a different discharge limit.');
      }
      this.desiredHold = false;
      this.recoverOnStart = false;
      this.persist(null);
      this.unavailable = false;
      return this.status();
    });
  }

  private read(): DeyeHoldRecord | null | undefined {
    // Retry an unavailable SDK read from the API or the recovery clock.
    if (this.record === undefined) this.record = readDeyeHoldRecord(this.settings);
    return this.record;
  }

  private persist(record: DeyeHoldRecord | null): void {
    try {
      if (record === null) this.settings.unset(DEYE_DISCHARGE_HOLD_KEY);
      else this.settings.set(DEYE_DISCHARGE_HOLD_KEY, record);
    } catch (error) {
      this.record = undefined;
      throw error;
    }
    this.record = record;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const result = this.queue.then(operation).finally(() => { this.queued -= 1; });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requestRelease(claim: DeyeClaim): DeyeClaim {
    return claim.releaseRequestedAtMs === undefined ? { ...claim, releaseRequestedAtMs: Date.now() } : claim;
  }

  private needsManualRecovery(claim?: DeyeClaim): boolean {
    const step = claim?.step;
    const overdue = (since: number | undefined) => since !== undefined && Date.now() - since >= RECOVERY_NOTICE_MS;
    return step?.kind === 'unreadable_order' || step?.kind === 'unexpected_limit'
      || (step?.kind === 'submitting' && !this.submitting)
      || overdue(claim?.releaseRequestedAtMs)
      || ((step?.kind === 'order' || step?.kind === 'readback') && overdue(step.sinceMs));
  }

  private wantsHold(): boolean {
    return this.enabled && !this.disabling && !this.recoverOnStart && this.desiredHold && this.canHold();
  }

  private kick(): void {
    if (!this.enabled || this.queued) return;
    void this.serial(async () => {
      await this.advance();
      this.unavailable = false;
    }).catch(() => {
      if (!this.unavailable) log.warn({ event: 'deye_discharge_hold_request_failed' });
      this.unavailable = true;
      this.retryAfterMs = Date.now() + POLL_MS;
    });
  }

  private async advance(): Promise<void> {
    const { record } = this;
    if (record === undefined || !this.enabled) return;
    if (!record?.claim) {
      this.recoverOnStart = false;
      if (record?.enabled && this.wantsHold() && !this.holdFailed && Date.now() >= this.retryAfterMs) {
        await this.beginHold(record);
      }
      return;
    }
    if (record.claim.step.kind === 'unreadable_order' || record.claim.step.kind === 'unexpected_limit') return;
    const claim = record.enabled && this.wantsHold() ? record.claim : this.requestRelease(record.claim);
    if (claim !== record.claim) this.persist({ ...record, claim });
    await this.advanceClaim(record, claim);
  }

  private async beginHold(record: DeyeHoldRecord): Promise<void> {
    const originalLimitA = await this.cloud.readLimit(record.credentials);
    if (originalLimitA === 0) {
      this.retryAfterMs = Date.now() + POLL_MS;
      return;
    }
    await this.submit(record, { originalLimitA, step: { kind: 'submitting', direction: 'hold' } }, 'hold');
  }

  private async submit(record: DeyeHoldRecord, claim: DeyeClaim, direction: 'hold' | 'restore'): Promise<void> {
    const amps = direction === 'hold' ? 0 : claim.originalLimitA;
    const submit = await this.cloud.prepareLimitWrite(record.credentials, amps);
    if (!this.enabled || (direction === 'hold' && !this.wantsHold())) return;
    // Persist first. A crash or ambiguous POST failure leaves this marker intact.
    this.persist({ ...record, claim: { ...claim, step: { kind: 'submitting', direction } } });
    this.submitting = true;
    try {
      const result = await submit();
      if (result.kind === 'authorization_rejected') {
        if (direction === 'hold') this.complete(record);
        else this.persist({ ...record, claim });
        throw new Error('Deye Cloud rejected access');
      }
      const step = { kind: 'order' as const, direction, orderId: result.orderId, sinceMs: Date.now() };
      this.persist({ ...record, claim: { ...claim, step } });
    } finally {
      this.submitting = false;
    }
  }

  private async advanceClaim(record: DeyeHoldRecord, claim: DeyeClaim): Promise<void> {
    const { step } = claim;
    if (step.kind === 'submitting') return;
    if (step.kind === 'order') {
      const result = await this.cloud.readOrder(record.credentials, step.orderId);
      if (result === 'pending') return;
      if (result === 'failed') {
        if (step.direction === 'hold') this.holdFailed = true;
        this.persist({ ...record, claim: { ...this.requestRelease(claim), step: { kind: 'restore_needed' } } });
        return;
      }
      this.persist({ ...record, claim: { ...claim, step: { ...step, kind: 'readback', sinceMs: Date.now() } } });
      return;
    }
    if (step.kind === 'held' && claim.releaseRequestedAtMs === undefined && this.wantsHold()) return;
    const current = await this.cloud.readLimit(record.credentials);
    if (step.kind === 'readback') {
      this.confirmOrder(record, claim, step.direction, current);
      return;
    }
    if (current === claim.originalLimitA) this.complete(record);
    else if (current === 0) await this.submit(record, claim, 'restore');
    // A different nonzero value may be an external change. Preserve it and the saved hand-back target.
    else this.persist({ ...record, claim: { ...claim, step: { kind: 'unexpected_limit' } } });
  }

  private confirmOrder(record: DeyeHoldRecord, claim: DeyeClaim, direction: 'hold' | 'restore', current: number): void {
    if (direction === 'hold' && current === 0) {
      this.persist({ ...record, claim: { ...claim, step: { kind: 'held' } } });
    }
    if (direction === 'restore' && current === claim.originalLimitA) this.complete(record);
    // Config readback can lag the terminal order. Keep the obligation if the value differs.
  }

  private complete(record: DeyeHoldRecord): void {
    this.recoverOnStart = false;
    if (record.enabled) this.persist({ enabled: true, credentials: record.credentials });
    else this.persist(null);
  }
}

export type MainDischargeHold = EvDischargeHoldLane & { start(): void; stop(): void };

export function bindMainDischargeHold(
  lane: MainDischargeHold | undefined,
  isPlanFenced: () => boolean,
  hasLiveMeter: () => boolean,
): EvDischargeHoldLane | undefined {
  if (!lane) return undefined;
  return {
    hasWork: (hold) => (!hold || !isPlanFenced()) && lane.hasWork(hold),
    apply: (hold, canHold) => {
      if (hold && isPlanFenced()) return;
      // The accepted intent outlives the reconcile that produced it. Keep its
      // authorization live between reconciles and through the cloud request.
      lane.apply(hold, () => canHold() && hasLiveMeter());
    },
  };
}
