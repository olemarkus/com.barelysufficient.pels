export type PlanMetaSnapshot = {
  totalKw?: number;
  softLimitKw?: number;
  capacitySoftLimitKw?: number;
  dailySoftLimitKw?: number | null;
  softLimitSource?: 'capacity' | 'daily' | 'both';
  headroomKw?: number;
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number;
  shortfallBudgetHeadroomKw?: number | null;
  hardCapHeadroomKw?: number | null;
  usedKWh?: number;
  budgetKWh?: number;
  minutesRemaining?: number;
  controlledKw?: number;
  uncontrolledKw?: number;
  hourControlledKWh?: number;
  hourUncontrolledKWh?: number;
  dailyBudgetHourKWh?: number;
  lastPowerUpdateMs?: number;
};

type PlanMetaLines = {
  now: string[];
  hour: string[];
};

type ValidatedMeta = {
  totalKw: number;
  softLimitKw: number;
  headroomKw: number;
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number;
  shortfallBudgetHeadroomKw?: number | null;
  hardCapHeadroomKw?: number | null;
  controlledKw?: number;
  uncontrolledKw?: number;
  lastPowerUpdateMs?: number;
};

type HardCapDisplay = {
  breached: boolean;
  breachText: string | null;
  remainingText: string | null;
};

export type PlanMetaBinding = {
  lineEl: HTMLDivElement;
  meta: ValidatedMeta;
};

const formatRelativeTime = (timestampMs: number, nowMs = Date.now()): string => {
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

const getSoftLimitSourceText = (source?: PlanMetaSnapshot['softLimitSource']) => {
  if (source === 'daily') return 'Limited by daily budget';
  if (source === 'both') return 'Limited by daily + capacity caps';
  return 'Limited by capacity cap';
};

const getDisplayBudgetKWh = (meta: PlanMetaSnapshot): number | null => {
  if (typeof meta.usedKWh !== 'number' || typeof meta.budgetKWh !== 'number') return null;
  return meta.softLimitSource === 'daily' && typeof meta.dailyBudgetHourKWh === 'number'
    ? meta.dailyBudgetHourKWh
    : meta.budgetKWh;
};

const getValidatedMeta = (meta: PlanMetaSnapshot | undefined): ValidatedMeta | null => {
  if (!meta) return null;
  const { totalKw, softLimitKw, headroomKw } = meta;
  if (typeof totalKw !== 'number' || typeof softLimitKw !== 'number' || typeof headroomKw !== 'number') {
    return null;
  }
  return {
    totalKw,
    softLimitKw,
    headroomKw,
    capacityShortfall: meta.capacityShortfall,
    shortfallBudgetThresholdKw: meta.shortfallBudgetThresholdKw,
    shortfallBudgetHeadroomKw: meta.shortfallBudgetHeadroomKw,
    hardCapHeadroomKw: meta.hardCapHeadroomKw,
    controlledKw: meta.controlledKw,
    uncontrolledKw: meta.uncontrolledKw,
    lastPowerUpdateMs: meta.lastPowerUpdateMs,
  };
};

const buildHardCapDisplay = (meta: ValidatedMeta): HardCapDisplay => {
  const { hardCapHeadroomKw } = meta;
  if (typeof hardCapHeadroomKw !== 'number') {
    return { breached: false, breachText: null, remainingText: null };
  }
  if (hardCapHeadroomKw < 0) {
    const breachKw = Math.abs(Math.min(0, hardCapHeadroomKw));
    return {
      breached: true,
      breachText: `Hard cap breached by ${breachKw.toFixed(1)}kW`,
      remainingText: null,
    };
  }
  return {
    breached: false,
    breachText: null,
    remainingText: `${hardCapHeadroomKw.toFixed(1)}kW before hard cap`,
  };
};

const buildNowLines = (meta: ValidatedMeta, nowMs: number): string[] => {
  const headroomAbs = Math.abs(meta.headroomKw).toFixed(1);
  const hardCap = buildHardCapDisplay(meta);
  const headroomText = hardCap.breachText
    ?? (meta.headroomKw >= 0 ? `${headroomAbs}kW available` : `${headroomAbs}kW over soft limit`);
  const ageText = typeof meta.lastPowerUpdateMs === 'number'
    ? ` (${formatRelativeTime(meta.lastPowerUpdateMs, nowMs)})`
    : '';
  const lines = [
    `Now ${meta.totalKw.toFixed(1)}kW${ageText} (soft limit ${meta.softLimitKw.toFixed(1)}kW)`,
    headroomText,
  ];
  if ((meta.capacityShortfall || hardCap.breached) && typeof meta.shortfallBudgetThresholdKw === 'number') {
    lines.push(`Shortfall threshold ${meta.shortfallBudgetThresholdKw.toFixed(1)}kW (hourly budget-derived)`);
  } else if (meta.headroomKw < 0 && hardCap.remainingText) {
    lines.push(hardCap.remainingText);
  }
  if (
    typeof meta.shortfallBudgetHeadroomKw === 'number'
    && meta.shortfallBudgetHeadroomKw !== meta.hardCapHeadroomKw
  ) {
    lines.push(`Shortfall-threshold headroom ${meta.shortfallBudgetHeadroomKw.toFixed(1)}kW`);
  }
  if (typeof meta.controlledKw === 'number' && typeof meta.uncontrolledKw === 'number') {
    lines.push(
      `Capacity-controlled ${meta.controlledKw.toFixed(2)}kW `
      + `/ Other load ${meta.uncontrolledKw.toFixed(2)}kW`,
    );
  }
  return lines;
};

const buildHourLines = (meta: PlanMetaSnapshot): string[] => {
  const lines: string[] = [];
  if (meta.softLimitSource) lines.push(getSoftLimitSourceText(meta.softLimitSource));
  const displayBudget = getDisplayBudgetKWh(meta);
  if (displayBudget !== null && typeof meta.usedKWh === 'number') {
    lines.push(`Used ${meta.usedKWh.toFixed(2)} of ${displayBudget.toFixed(1)} kWh`);
  }
  if (typeof meta.hourControlledKWh === 'number' && typeof meta.hourUncontrolledKWh === 'number') {
    lines.push(
      `Capacity-controlled ${meta.hourControlledKWh.toFixed(2)} `
      + `/ Other load ${meta.hourUncontrolledKWh.toFixed(2)} kWh`,
    );
  }
  if (typeof meta.minutesRemaining === 'number' && meta.minutesRemaining <= 10) lines.push('End of hour');
  return lines;
};

const buildPlanMetaLines = (meta: PlanMetaSnapshot | undefined, nowMs: number): PlanMetaLines | null => {
  const validated = getValidatedMeta(meta);
  if (!validated || !meta) return null;
  return { now: buildNowLines(validated, nowMs), hour: buildHourLines(meta) };
};

export const renderPlanMeta = (
  container: HTMLElement,
  meta: PlanMetaSnapshot | undefined,
  nowMs: number,
): PlanMetaBinding | null => {
  const target = container;
  const metaLines = buildPlanMetaLines(meta, nowMs);
  const validatedMeta = getValidatedMeta(meta);
  if (!metaLines) {
    target.textContent = 'Awaiting data';
    return null;
  }

  target.innerHTML = '';
  let binding: PlanMetaBinding | null = null;
  const addSection = (title: string, sectionLines: string[]) => {
    if (sectionLines.length === 0) return;
    const section = document.createElement('div');
    section.className = 'plan-meta-section';
    const heading = document.createElement('div');
    heading.className = 'plan-meta-title';
    heading.textContent = title;
    section.appendChild(heading);
    sectionLines.forEach((line, index) => {
      const div = document.createElement('div');
      div.className = 'plan-meta-line-text';
      div.textContent = line;
      if (title === 'Now' && index === 0 && validatedMeta && typeof meta?.lastPowerUpdateMs === 'number') {
        binding = { lineEl: div, meta: validatedMeta };
      }
      section.appendChild(div);
    });
    target.appendChild(section);
  };

  addSection('Now', metaLines.now);
  if (metaLines.now.length && metaLines.hour.length) {
    const divider = document.createElement('div');
    divider.className = 'plan-meta-divider';
    target.appendChild(divider);
  }
  addSection('This hour', metaLines.hour);
  return binding;
};

export const updatePlanMetaBinding = (binding: PlanMetaBinding | null, nowMs: number) => {
  if (!binding) return;
  const target = binding.lineEl;
  target.textContent = buildNowLines(binding.meta, nowMs)[0] ?? '';
};
