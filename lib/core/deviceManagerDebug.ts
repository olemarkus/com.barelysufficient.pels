const HOMEY_API_ERROR_DEBUG_MARKERS = ['error', 'failed', 'invalid response', 'timeout'];

const getHomeyApiDebugText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Record<string, unknown>;
  return [
    record.name,
    record.code,
    record.description,
    record.message,
    record.stack,
    typeof record.statusCode === 'number' ? String(record.statusCode) : '',
  ]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .join(' ');
};

export const shouldPromoteHomeyApiDebug = (args: unknown[]): boolean => {
  if (args.some((arg) => arg instanceof Error)) return true;
  const normalized = args
    .map((arg) => getHomeyApiDebugText(arg))
    .filter((value) => value.length > 0)
    .join(' ')
    .toLowerCase();
  return normalized.length > 0
    && HOMEY_API_ERROR_DEBUG_MARKERS.some((marker) => normalized.includes(marker));
};
