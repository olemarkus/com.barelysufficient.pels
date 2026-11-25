/** A bounded firmware label from an integration's device settings or capabilities. */
export const readFirmwareVersion = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 256) return undefined;
  const version = value.trim();
  return /\d/u.test(version) && !/[\p{Cc}\p{Cf}]/u.test(version) ? version : undefined;
};
