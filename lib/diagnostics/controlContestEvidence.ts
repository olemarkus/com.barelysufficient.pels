import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { readFlowCapabilityWrites, type FlowApiGet, type FlowReadResult } from '../flowApi/readUserFlows';
import { findStandardFlowWriters, type StandardFlowCapability } from '../flowApi/flowConflict';
import { getLogger } from '../logging/logger';
import type { ControlContestOccurrence } from '../ports/controlContest';
import type { DeviceJournal } from '../ports/deviceJournal';
import { resolveHomeyHttpStatusCode } from '../utils/homeyHttpStatusError';
import type { ShutdownLatch } from '../utils/shutdownLatch';

const READ_DEADLINE_MS = 10_000;
/** Let both evidence reads finish before the automatic report takes its snapshot. */
export const CONTROL_CONTEST_REPORT_GRACE_MS = READ_DEADLINE_MS + 5_000;
const BEFORE_FIRST_ROUND_MS = 60_000;
const MAX_TIMELINE_ENTRIES = 16;
const MAX_ACTIVE_DEVICES = 2;
const READ_TIMED_OUT = Symbol('contest evidence read timed out');
const logger = getLogger('diagnostics/control-contest');

const CAPABILITIES = {
  on_off: 'onoff',
  temperature: 'target_temperature',
} as const;

export function hasControlContestEvidence(setting: unknown): setting is keyof typeof CAPABILITIES {
  return setting === 'on_off' || setting === 'temperature';
}

type Unavailable = {
  state: 'unavailable';
  reason: 'timeout' | 'missing_log' | 'invalid_response' | 'read_failed';
};

type TimelineEntry = {
  atMs: number;
  value: boolean | number;
  originUri?: string;
  originName?: string;
};

const unavailable = (reason: Unavailable['reason']): Unavailable => ({ state: 'unavailable', reason });

async function withReadDeadline<T>(read: Promise<T>): Promise<T | typeof READ_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof READ_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(READ_TIMED_OUT), READ_DEADLINE_MS);
  });
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function readTimelineEntry(raw: unknown, capability: StandardFlowCapability): TimelineEntry[] {
  if (!isUnknownRecord(raw) || typeof raw.t !== 'string') return [];
  const atMs = Date.parse(raw.t);
  const value = raw.v;
  if (!Number.isFinite(atMs)) return [];
  if (typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) return [];
  if ((capability === 'onoff') !== (typeof value === 'boolean')) return [];

  // Homey also provides user and client names and IDs. Keep app and Flow origins only.
  const { originUri, originName } = raw;
  if (typeof originUri === 'string' && /^homey:(?:app|flow|advancedflow):[\w.-]{1,160}$/.test(originUri)) {
    return [{
      atMs, value, originUri,
      ...(typeof originName === 'string' ? { originName: originName.slice(0, 160) } : {}),
    }];
  }
  return [{ atMs, value }];
}

async function readTimeline(get: FlowApiGet, contest: ControlContestOccurrence, capability: StandardFlowCapability) {
  const owner = `homey:device:${encodeURIComponent(contest.deviceId)}`;
  const logId = `${owner}:${capability}`;
  // Boolean logs return recent changes. Numeric logs use five-second samples at lastHour resolution.
  const resolution = capability === 'onoff' ? 'last24Hours' : 'lastHour';
  const path = `manager/insights/log/${owner}/${logId}/entry?resolution=${resolution}`;
  try {
    const raw = await withReadDeadline(get(path));
    if (raw === READ_TIMED_OUT) return unavailable('timeout');
    if (!isUnknownRecord(raw) || !Array.isArray(raw.values)) return unavailable('invalid_response');
    const parsed = raw.values.flatMap((entry: unknown) => readTimelineEntry(entry, capability));
    if (raw.values.length > 0 && parsed.length === 0) return unavailable('invalid_response');

    // The last round ends when PELS reasserts the command. The preceding changes are the disputed ones.
    const fromMs = contest.firstAtMs - BEFORE_FIRST_ROUND_MS;
    const entries = parsed.filter(({ atMs }) => atMs >= fromMs && atMs <= contest.lastAtMs)
      .sort((a, b) => a.atMs - b.atMs);
    return {
      state: 'available' as const, entries: entries.slice(-MAX_TIMELINE_ENTRIES),
      leftOut: Math.max(0, entries.length - MAX_TIMELINE_ENTRIES),
    };
  } catch (error) {
    return unavailable(resolveHomeyHttpStatusCode(error) === 404 ? 'missing_log' : 'read_failed');
  }
}

/** Collect historical evidence for a reported contest, independently of device control. */
export class ControlContestEvidence {
  private readonly active = new Set<string>();
  private flowRead: Promise<FlowReadResult | typeof READ_TIMED_OUT> | undefined;

  constructor(
    private readonly get: FlowApiGet,
    private readonly journal: DeviceJournal,
    private readonly shutdown: Pick<ShutdownLatch, 'isStopped'>,
  ) {}

  readonly collect = (contest: ControlContestOccurrence): void => {
    if (this.shutdown.isStopped() || !hasControlContestEvidence(contest.setting)) return;
    if (this.active.has(contest.deviceId) || this.active.size >= MAX_ACTIVE_DEVICES) {
      queueMicrotask(() => this.record(contest, { state: 'skipped', reason: 'busy' }));
      return;
    }

    const capability = CAPABILITIES[contest.setting];
    this.active.add(contest.deviceId);
    void Promise.resolve().then(async () => {
      if (this.shutdown.isStopped()) return;
      const [timeline, candidateFlows] = await Promise.all([
        readTimeline(this.get, contest, capability),
        this.readCandidates(contest.deviceId, capability),
      ]);
      this.record(contest, { timeline, candidateFlows });
    }).catch(() => {
      this.record(contest, { state: 'unavailable', reason: 'capture_failed' });
    }).finally(() => { this.active.delete(contest.deviceId); });
  };

  private async readCandidates(deviceId: string, capability: StandardFlowCapability) {
    try {
      this.flowRead ??= withReadDeadline(readFlowCapabilityWrites({ get: this.get }))
        .finally(() => { this.flowRead = undefined; });
      const result = await this.flowRead;
      if (result === READ_TIMED_OUT) return unavailable('timeout');
      if (result.status === 'unknown') return unavailable('read_failed');
      return { state: 'available' as const, ...findStandardFlowWriters(result.facts.writes, deviceId, capability) };
    } catch {
      return unavailable('read_failed');
    }
  }

  private record(contest: ControlContestOccurrence, evidence: Readonly<Record<string, unknown>>): void {
    if (this.shutdown.isStopped()) return;
    const { deviceId, setting, firstAtMs, lastAtMs } = contest;
    const event = {
      component: 'diagnostics', event: 'device_control_contest_evidence',
      deviceId, setting, firstAtMs, lastAtMs, ...evidence,
    };
    logger.info(event);
    this.journal.record([deviceId], event);
  }
}
