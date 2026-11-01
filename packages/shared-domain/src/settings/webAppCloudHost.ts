/**
 * The `web_app_cloud_host` setting: the Homey's own Athom cloud host, for the
 * standalone web app.
 *
 * Homey reports its cloud cluster nowhere, and the web app needs the host to
 * reach the Homey away from home without Athom's relay, which lets a Homey
 * through only a few dozen calls in a burst. Homey's web app serves the settings
 * page from that host whenever it reaches the Homey through the cloud, so the
 * page saves its own origin here (`packages/settings-ui/src/ui/webAppLink.ts`)
 * and `ui_version` hands it out (`lib/app/settingsUiVersion.ts`), so every
 * browser learns it, even one that only ever opens PELS at home. The page carries it in the bootstrap,
 * so checking it costs no call.
 *
 * A learned value in settings rather than the userdata store: keeping it there
 * needs no API route of its own (owner, 2026-10-23).
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

import { cloudHostHomeyId, ownCloudHostFor } from '../homeyCloudHost.js';

/** Read policy: the stored host when it is this Homey's own cloud host, else none. */
export const readWebAppCloudHost = (raw: unknown, homeyId: string): string | null => (
  typeof raw === 'string' ? ownCloudHostFor(raw, homeyId) : null
);

/** Write policy: a page origin worth saving, which is any Homey's own cloud host; else none. */
export const webAppCloudHostFromOrigin = (origin: string): string | null => {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return null;
  }
  const homeyId = cloudHostHomeyId(hostname);
  return homeyId === null ? null : ownCloudHostFor(origin, homeyId);
};
