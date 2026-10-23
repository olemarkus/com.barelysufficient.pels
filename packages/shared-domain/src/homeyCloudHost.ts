// The Homey's own cloud host: `<homeyId>.homey.<cluster>.homeypro.net` for a
// Homey Pro and `.homeyshs.net` for a Self-Hosted Server. Homey's web app
// serves the PELS settings page and all its calls from it, and unlike Athom's
// relay it does not limit a Homey to a few dozen calls in a burst. The cluster
// cannot be derived from the id and Homey does not report it, so PELS learns
// the host from the settings page's own origin (`settings/webAppCloudHost.ts`)
// and hands it to the web app, which needs it to reach the Homey away from
// home. Both sides hold an address to the same rule: an API key goes wherever
// it is sent, so only an Athom host named for that very Homey qualifies.

const CLOUD_HOST = /^([a-f0-9]{24})\.homey\.[a-z0-9-]+\.(homeypro|homeyshs)\.net$/i;

/** The Homey a host name is the cloud host of, or null for any other host. */
export const cloudHostHomeyId = (hostname: string): string | null => (
  CLOUD_HOST.exec(hostname)?.[1]?.toLowerCase() ?? null
);

/** `origin` as this Homey's own cloud host (an `https://` origin), or null when it is anything else. */
export const ownCloudHostFor = (origin: string, homeyId: string): string | null => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '') return null;
  return cloudHostHomeyId(url.hostname) === homeyId.toLowerCase() ? url.origin : null;
};
