import { getRecentPlanRebuildTraces, summarizeRecentPlanRebuildTraces } from './planRebuildTrace';
import { listRecentRuntimeSpans, listRuntimeSpans } from './runtimeTrace';

const MB = 1024 * 1024;

type CpuSample = {
  wallMs: number;
  userMs: number;
  systemMs: number;
  cpuPct: number;
  lagMs: number;
};

const resolveMemorySummary = (): string => {
  try {
    const memory = process.memoryUsage();
    return `rssMb=${(memory.rss / MB).toFixed(1)} heapMb=${(memory.heapUsed / MB).toFixed(1)}`;
  } catch {
    return 'rssMb=n/a heapMb=n/a';
  }
};

const takeCpuSample = (
  previousCpuUsage: NodeJS.CpuUsage,
  previousTickNs: bigint,
  effectiveIntervalMs: number,
): {
  nextCpuUsage: NodeJS.CpuUsage;
  nextTickNs: bigint;
  sample: CpuSample;
} => {
  const currentTickNs = process.hrtime.bigint();
  const wallMs = Number(currentTickNs - previousTickNs) / 1_000_000;
  const cpuDelta = process.cpuUsage(previousCpuUsage);
  const userMs = cpuDelta.user / 1000;
  const systemMs = cpuDelta.system / 1000;
  const cpuMs = userMs + systemMs;

  return {
    nextCpuUsage: process.cpuUsage(),
    nextTickNs: currentTickNs,
    sample: {
      wallMs,
      userMs,
      systemMs,
      cpuPct: wallMs > 0 ? (cpuMs / wallMs) * 100 : 0,
      lagMs: Math.max(0, wallMs - effectiveIntervalMs),
    },
  };
};

const buildRebuildSummary = (nowMs: number): string => {
  const rebuildWindow = summarizeRecentPlanRebuildTraces(120_000, nowMs);
  if (rebuildWindow.count === 0) return '';

  const recentRebuilds = getRecentPlanRebuildTraces(3, nowMs)
    .map((trace) => `${trace.reason}:${trace.totalMs}ms age=${trace.ageMs}ms`)
    .join(' | ');

  return [
    `rebuildWindow=count=${rebuildWindow.count}`,
    `maxTotalMs=${rebuildWindow.maxTotalMs}`,
    `maxQueueWaitMs=${rebuildWindow.maxQueueWaitMs}`,
    `maxApplyMs=${rebuildWindow.maxApplyMs}`,
    `recentRebuilds=${recentRebuilds}`,
  ].join(' ');
};

const buildCpuSpikeMessage = (sample: CpuSample, nowMs: number): string => {
  const cpuSummary = [
    `cpu=${sample.cpuPct.toFixed(1)}%`,
    `wall=${sample.wallMs.toFixed(0)}ms`,
    `lag=${sample.lagMs.toFixed(0)}ms`,
    `userMs=${sample.userMs.toFixed(1)}`,
    `sysMs=${sample.systemMs.toFixed(1)}`,
  ].join(' ');
  const activeSpans = listRuntimeSpans(12, nowMs);
  const recentSpans = listRecentRuntimeSpans(24, 30_000, nowMs);
  const activeSummary = activeSpans.length > 0 ? activeSpans.join(' | ') : 'none';
  const recentSummary = recentSpans.length > 0 ? recentSpans.join(' | ') : 'none';
  const rebuildSummary = buildRebuildSummary(nowMs);
  const suffix = rebuildSummary ? ` ${rebuildSummary}` : '';

  return [
    '[perf] cpu spike',
    cpuSummary,
    resolveMemorySummary(),
    `active=${activeSummary}`,
    `recent=${recentSummary}${suffix}`,
  ].join(' ');
};

export const startCpuSpikeMonitor = (params: {
  log: (...args: unknown[]) => void;
  isEnabled?: () => boolean;
  sampleIntervalMs?: number;
  cpuThresholdPct?: number;
  minConsecutiveSamples?: number;
  minLogIntervalMs?: number;
}): (() => void) => {
  const {
    log,
    isEnabled,
    sampleIntervalMs = 1000,
    cpuThresholdPct = 85,
    minConsecutiveSamples = 1,
    minLogIntervalMs = 5000,
  } = params;
  const effectiveIntervalMs = Math.max(250, sampleIntervalMs);

  let previousCpuUsage = process.cpuUsage();
  let previousTickNs = process.hrtime.bigint();
  let consecutiveSamples = 0;
  let lastLogAtMs = 0;

  const timer = setInterval(() => {
    try {
      if (typeof isEnabled === 'function' && !isEnabled()) {
        previousCpuUsage = process.cpuUsage();
        previousTickNs = process.hrtime.bigint();
        consecutiveSamples = 0;
        return;
      }

      const { nextCpuUsage, nextTickNs, sample } = takeCpuSample(
        previousCpuUsage,
        previousTickNs,
        effectiveIntervalMs,
      );
      previousCpuUsage = nextCpuUsage;
      previousTickNs = nextTickNs;

      const highCpu = Number.isFinite(sample.cpuPct) && sample.cpuPct >= cpuThresholdPct;
      if (!highCpu) {
        consecutiveSamples = 0;
        return;
      }

      consecutiveSamples += 1;
      const delayedSample = sample.wallMs >= effectiveIntervalMs * 1.5;
      if (consecutiveSamples < minConsecutiveSamples && !delayedSample) return;

      const nowMs = Date.now();
      if ((nowMs - lastLogAtMs) < minLogIntervalMs) return;

      lastLogAtMs = nowMs;
      log(buildCpuSpikeMessage(sample, nowMs));
    } catch (error) {
      log(`[perf] cpu spike monitor error ${(error as Error).message}`);
    }
  }, effectiveIntervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  if (typeof isEnabled !== 'function' || isEnabled()) {
    log(`[perf] cpu spike monitor started interval=${effectiveIntervalMs}ms threshold=${cpuThresholdPct}%`);
  }

  return () => {
    clearInterval(timer);
  };
};
