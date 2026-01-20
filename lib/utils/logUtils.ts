export const sanitizeLogValue = (value: string): string => {
  if (!value) return '';
  const cleaned = value.replace(/[^a-zA-Z0-9 _.-]/g, ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
};

export const safeJsonStringify = (payload: unknown): string => {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[unserializable device object: ${message}]`;
  }
};
