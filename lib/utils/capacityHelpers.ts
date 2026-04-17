import type { ShedAction, ShedBehavior } from '../plan/planTypes';

export function resolveModeName(name: string, modeAliases: Record<string, string>): string {
  const current = name.trim();
  const mapped = modeAliases[current.toLowerCase()];
  if (typeof mapped === 'string' && mapped.trim()) return mapped;
  return current;
}

export function getAllModes(
  operatingMode: string,
  capacityPriorities: Record<string, Record<string, number>>,
  modeDeviceTargets: Record<string, Record<string, number>>,
): Set<string> {
  const modes = new Set<string>();
  if (operatingMode) modes.add(operatingMode);
  Object.keys(capacityPriorities || {}).forEach((mode) => {
    if (mode && mode.trim()) modes.add(mode);
  });
  Object.keys(modeDeviceTargets || {}).forEach((mode) => {
    if (mode && mode.trim()) modes.add(mode);
  });
  return modes;
}

export function normalizeShedBehaviors(input: unknown): Record<string, ShedBehavior> {
  if (!isRecord(input)) return {};
  const entries = Object.entries(input).flatMap(([deviceId, raw]) => {
    if (!raw || typeof raw !== 'object') return [];
    const candidate = raw as { action?: unknown; temperature?: unknown; stepId?: unknown };
    let action: ShedAction = 'turn_off';
    if (candidate.action === 'set_temperature') {
      action = 'set_temperature';
    } else if (candidate.action === 'set_step') {
      action = 'set_step';
    }
    const tempRaw = candidate.temperature;
    const temperature = typeof tempRaw === 'number' && Number.isFinite(tempRaw)
      ? Math.max(-50, Math.min(50, tempRaw))
      : undefined;
    let behavior: ShedBehavior = { action: 'turn_off' };
    if (action === 'set_temperature' && typeof temperature === 'number') {
      behavior = { action, temperature };
    } else if (action === 'set_step') {
      behavior = { action };
    }
    return [[deviceId, behavior]];
  });
  return Object.fromEntries(entries);
}

export function getShedBehavior(
  deviceId: string,
  shedBehaviors: Record<string, ShedBehavior>,
): { action: ShedAction; temperature: number | null; stepId: string | null } {
  const behavior = shedBehaviors[deviceId];
  let action: ShedAction = 'turn_off';
  if (behavior?.action === 'set_temperature') {
    action = 'set_temperature';
  } else if (behavior?.action === 'set_step') {
    action = 'set_step';
  }
  const temp = behavior?.temperature;
  const temperature = Number.isFinite(temp) ? Math.max(-50, Math.min(50, Number(temp))) : null;
  const stepId = typeof behavior?.stepId === 'string' && behavior.stepId.trim() ? behavior.stepId.trim() : null;
  return { action, temperature, stepId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
