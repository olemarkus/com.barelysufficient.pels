// Per-device minimum-run-time ("anti-cycle hold") override map normalization.
//
// The override map is persisted as `Record<deviceId, number>` (minutes). The
// stored payload is untrusted: external edits or partial saves can leave
// negative, non-finite, or non-numeric entries, or keys with surrounding
// whitespace. Both the runtime (the capacity settings snapshot builder in
// `setup/appSettingsHelpers.ts`) and the browser settings-UI (`minRunSettings.ts`)
// must normalize the map the same way, and shared-domain is the only layer both
// may import — so this is the single producer of the normalized form (mirrors
// the `normalizeModePriorities` precedent in `modePriorities.ts`).
//
// Keep only finite, non-negative entries with a non-empty (trimmed) key. `0` is
// RETAINED — it is the explicit per-device opt-out (legacy grace). A negative or
// non-finite entry is dropped so it falls through to the global default / legacy
// path rather than poisoning the resolution.
export function normalizeMinRunMinutesMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      const normalizedKey = key.trim();
      return normalizedKey && typeof entry === 'number' && Number.isFinite(entry) && entry >= 0
        ? [[normalizedKey, entry]]
        : [];
    }),
  );
}
