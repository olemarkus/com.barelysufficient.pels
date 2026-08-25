/**
 * The PV-forecast source status as the settings UI receives and renders it:
 * one shape guard for the seam, one resolver for the sentence.
 *
 * Both live here rather than in the view because they are pure state
 * resolution and text formatting with no DOM and no Preact — the split
 * `packages/settings-ui/src/ui/views/AGENTS.md` requires, so they can be tested
 * on their own and stay reusable.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

import type { PvForecastSourceUiStatus } from '../../../contracts/src/settingsUiApi.js';

/**
 * Resolve an untrusted `pvForecastSource` payload field into the typed status.
 *
 * The prices read model crosses the Homey API bridge into the WebView, which is
 * an untrusted transport: the payload is a cast, not a verified value. This is
 * the receiving adapter that root `AGENTS.md` § "Clean and trusted interfaces
 * between layers" puts the single validation at — inward of here the view reads
 * the status directly and never re-checks it.
 *
 * Anything that is not a complete, well-formed status resolves to `null`, which
 * the section already renders as "say nothing" (the pre-boot state). A partial
 * object is deliberately NOT repaired field by field: a malformed `activeSource`
 * would otherwise fall through the resolver as though it were `learned`, and a
 * non-boolean availability field would state provenance the runtime never
 * reported.
 */
export const resolvePvForecastSourceUiStatus = (
  value: unknown,
): PvForecastSourceUiStatus | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { activeSource, homeyForecastAvailable, learnedForecastAvailable } = record;
  if (activeSource !== null && activeSource !== 'homey_energy' && activeSource !== 'learned') {
    return null;
  }
  if (typeof homeyForecastAvailable !== 'boolean' || typeof learnedForecastAvailable !== 'boolean') {
    return null;
  }
  return { activeSource, homeyForecastAvailable, learnedForecastAvailable };
};

/**
 * Which forecast actually feeds planning right now. `null` (say nothing) until
 * the runtime selector reports. The selected-but-empty states each get their
 * own honest sentence — and the pinned-Homey one names the real toggle out,
 * because remedy copy names the control the owner would actually use.
 */
export const resolvePvForecastStatusLine = (
  status: PvForecastSourceUiStatus | null,
): string | null => {
  if (!status || status.activeSource === null) return null;
  if (status.activeSource === 'homey_energy') {
    return status.homeyForecastAvailable
      ? 'Using Homey’s solar forecast.'
      : 'Homey has no solar forecast yet, so planning runs without one. '
        + 'Switch to Automatic to use the forecast PELS learns from your solar production.';
  }
  return status.learnedForecastAvailable
    ? 'Using the forecast PELS learns from your solar production.'
    : 'PELS is still learning your solar production, so planning runs without a forecast yet.';
};
