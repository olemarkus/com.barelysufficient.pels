/** What the owner-authenticated app manager API needs from the running app. */
export type HomeyAppManagerRuntime = {
  manifest: { id: string };
  api: { getOwnerApiToken(): Promise<string>; getLocalUrl(): Promise<string> };
};

export type HomeyAppManagerResponse = { ok: boolean; status: number; body: unknown };

/**
 * One request to Homey's manager API about this app (`/api/manager/apps/app/<id><suffix>`),
 * with the owner token, which the app-session API lacks for these routes.
 *
 * The deadline covers the SDK's URL and token reads as well as the HTTP call:
 * a read that never settles must not leave the caller waiting forever.
 */
export const requestHomeyAppManager = async (
  homey: HomeyAppManagerRuntime,
  suffix: string,
  method: 'GET' | 'POST',
  message: string | undefined,
  timeoutMs: number,
): Promise<HomeyAppManagerResponse> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Homey app manager request timed out'));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([perform(homey, suffix, method, message, controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const perform = async (
  homey: HomeyAppManagerRuntime,
  suffix: string,
  method: 'GET' | 'POST',
  message: string | undefined,
  signal: AbortSignal,
): Promise<HomeyAppManagerResponse> => {
  const [baseUrl, token] = await Promise.all([homey.api.getLocalUrl(), homey.api.getOwnerApiToken()]);
  signal.throwIfAborted();
  if (!token) throw new Error('Homey authentication unavailable');
  const path = `/api/manager/apps/app/${encodeURIComponent(homey.manifest.id)}${suffix}`;
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(message === undefined ? {} : { body: JSON.stringify({ message }) }),
    signal,
    redirect: 'error',
  });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: response.ok, status: response.status, body };
};
