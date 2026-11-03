// The Homey Self-Hosted Server the SHS suite runs on, and what the suite does
// to it: install PELS and test-devices from scratch, pair the mocks a scenario
// needs, and set PELS up the way the settings UI does.
//
// Only a self-hosted server is ever touched. The box is the active Homey of the
// SHS CLI store (`HOMEY_SHS_HOME`, default `~/.athom-cli-shs`; `with-homey-shs2`
// selects the second box), and the suite refuses any Homey whose name does not
// say it is self-hosted, so it cannot reach the production Homey Pro that the
// default `~/.athom-cli` store points at.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PELS_APP_ID = 'com.barelysufficient.pels';
export const TEST_DEVICES_APP_ID = 'com.olemarkus.testdevices';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The box from the SHS CLI store, or a refusal when the store's active Homey is not a self-hosted server. */
export const resolveBox = () => {
  const store = process.env.HOMEY_SHS_HOME || join(homedir(), '.athom-cli-shs');
  const settings = JSON.parse(readFileSync(join(store, 'settings.json'), 'utf8'));
  const active = settings.activeHomey ?? {};
  const name = String(active.name ?? '');
  if ((active.platform && active.platform !== 'local') || !/self[-\s]?hosted/i.test(name)) {
    throw new Error(`Refusing: the active Homey in ${store} is "${name}" (${active.id}), not a self-hosted server.`);
  }
  const token = settings.homeyApi?.[`homey-${active.id}`]?.token;
  if (!token) throw new Error(`No API token for ${active.id} in ${store}; log in to the box with the Homey CLI first.`);
  return { store, id: active.id, name, token, port: Number(process.env.SHS_API_PORT) || 4859 };
};

/** The Homey Web API on the box, over loopback. */
export const createHomeyApi = (box) => {
  const request = (method, path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: box.port,
      path,
      method,
      family: 4,
      headers: {
        Authorization: `Bearer ${box.token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`${method} ${path} → ${res.statusCode}: ${raw.slice(0, 400)}`));
          return;
        }
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(raw);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${path} timed out`)));
    if (payload) req.write(payload);
    req.end();
  });
  return {
    get: (path) => request('GET', path),
    put: (path, body) => request('PUT', path, body),
    post: (path, body) => request('POST', path, body),
    delete: (path) => request('DELETE', path),
  };
};

/** Poll `read` until `done` accepts its answer, or fail with `what` after `timeoutMs`. */
export const waitFor = async (what, read, done, { timeoutMs = 120_000, everyMs = 2_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await read();
      if (done(last)) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      const seen = last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300);
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}; last saw ${seen}`);
    }
    await sleep(everyMs);
  }
};

const appIdAt = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8')).id;
  } catch {
    return undefined;
  }
};

/**
 * Stop every `homey app run` on this machine that holds `appId` on this box.
 * A run session uninstalls its app when it exits, so one left running would
 * pull the app out from under the suite whenever it ends. SIGINT is Ctrl-C:
 * the session uninstalls its app and exits.
 */
export const stopRunSessions = async (box, appId) => {
  const stopped = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
      if (!cmd.some((part) => part.endsWith('homey')) || !cmd.includes('run') || !cmd.includes('app')) continue;
      const env = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0');
      const home = env.find((line) => line.startsWith('HOMEY_HOME='))?.slice('HOMEY_HOME='.length);
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      if ((home ?? join(homedir(), '.athom-cli')) !== box.store || appIdAt(cwd) !== appId) continue;
      process.kill(Number(entry), 'SIGINT');
      stopped.push({ pid: Number(entry), cwd });
    } catch {
      // A process that exited or that this user cannot read is not one to stop.
    }
  }
  for (const { pid } of stopped) {
    await waitFor(`run session ${pid} to exit`, () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, Boolean, { timeoutMs: 60_000, everyMs: 1_000 });
  }
  return stopped;
};

/**
 * `homey app install --clean` from `dir`: the app's settings, userdata and
 * paired devices go, so the scenario starts from a first install.
 */
export const installClean = async (box, api, dir, appId) => {
  await new Promise((resolve, reject) => {
    const child = spawn('homey', ['app', 'install', '--clean', '--path', dir], {
      env: { ...process.env, HOMEY_HOME: box.store },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`homey app install exited ${code} for ${dir}`))));
  });
  await waitFor(`${appId} to run`, () => api.get(`/api/manager/apps/app/${appId}`), (app) => app?.state === 'running');
};

export const commitOf = (dir) => execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

const driverUri = (driver) => `homey:app:${TEST_DEVICES_APP_ID}:${driver}`;

/** Pair one test-devices mock through the pair-session API the Homey app drives. */
export const pairMock = async (api, driver) => {
  const zones = Object.values(await api.get('/api/manager/zones/zone/'));
  const zoneId = (zones.find((zone) => zone.parent === null) ?? zones[0])?.id;
  const session = await api.post('/api/manager/drivers/pairsession', {
    type: 'pair', driverId: driverUri(driver), ...(zoneId ? { zoneId } : {}),
  });
  const sessionId = session.id ?? session;
  try {
    const listed = await api.post(`/api/manager/drivers/pairsession/${sessionId}/emit`, { event: 'list_devices', data: {} });
    const [candidate] = Array.isArray(listed) ? listed : listed?.result ?? [];
    if (!candidate) throw new Error(`${driver}: list_devices returned nothing`);
    const created = await api.post(`/api/manager/drivers/pairsession/${sessionId}/device`, {
      ...candidate, ...(zoneId ? { zone: zoneId } : {}),
    });
    return { id: created.id ?? created, name: candidate.name };
  } finally {
    await api.delete(`/api/manager/drivers/pairsession/${sessionId}`).catch(() => {});
  }
};

/** Run a test-devices Flow action card, as a Flow would. */
export const runMockCard = (api, card, args) => api.post(
  `/api/manager/flow/flowcardaction/homey:app:${TEST_DEVICES_APP_ID}/homey:app:${TEST_DEVICES_APP_ID}:${card}/run`,
  { args },
);

export const readDevice = (api, deviceId) => api.get(`/api/manager/devices/device/${deviceId}`);

export const readCapability = async (api, deviceId, capabilityId) => (
  (await readDevice(api, deviceId)).capabilitiesObj?.[capabilityId]?.value
);

/** Something outside PELS (another app, a Flow) sets a capability through the Web API. */
export const setCapability = (api, deviceId, capabilityId, value) => api.put(
  `/api/manager/devices/device/${deviceId}/capability/${capabilityId}`,
  { value },
);

/** PELS as the settings UI reaches it: its app settings and its API routes. */
export const createPels = (api) => ({
  writeSetting: (key, value) => api.put(`/api/manager/apps/app/${PELS_APP_ID}/setting/${key}`, { value }),
  get: (route) => api.get(`/api/app/${PELS_APP_ID}${route}`),
  post: (route, body) => api.post(`/api/app/${PELS_APP_ID}${route}`, body),
});
