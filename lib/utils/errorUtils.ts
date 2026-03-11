const describeErrorValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string') return serialized;
  } catch {
    // Fall through to String() for circular or host objects.
  }
  return String(value);
};

export const normalizeError = (value: unknown): Error => (
  value instanceof Error ? value : new Error(describeErrorValue(value))
);
