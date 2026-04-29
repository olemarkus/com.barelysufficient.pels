import type { ShedCandidate } from './types';

export function isNotAtShedTemperature(device: ShedCandidate): boolean {
  if (device.kind !== 'temperature') return true;
  const currentTarget = device.targets?.find((t) => t.id === device.targetCapabilityId)?.value;
  return !(typeof currentTarget === 'number' && currentTarget === device.shedTemperature);
}
