export type LastResortDevices = Readonly<Record<string, number>>;

export const isLastResortMaximumW = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
);

export function readLastResortDevices(value: unknown): LastResortDevices | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([id, maximum]) => id.length > 0 && isLastResortMaximumW(maximum))) return undefined;
  return Object.fromEntries(entries);
}
