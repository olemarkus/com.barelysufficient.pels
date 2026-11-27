import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Homey from 'homey';
import { initHomeyHttpClient } from '../../lib/device/transport/managerHomeyApi';
import { fetchDevicesWithFallback, readDevicesForDiagnostics } from '../../lib/device/transport/managerFetch';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { getLogger } from '../../lib/logging/logger';

const testLogger = { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/diagnostics') };

const rawDevice = (id: string, name = id) => ({
  id, name, class: 'socket', driverUri: 'homey:app:com.example.relay', driverId: 'switch',
  available: true, capabilities: ['onoff'], capabilitiesObj: { onoff: { value: true } },
  settings: { nested: [{ edge: '\\"}],{' }] },
});

async function collectDevices(devices: AsyncIterable<HomeyDeviceLike>) {
  const rows: { id: string; name: string; driverId: string }[] = [];
  for await (const { id, name, driverId } of devices) rows.push({ id, name, driverId });
  return rows;
}

const expected = (id: string, name = id) => ({ id, name, driverId: 'homey:app:com.example.relay:switch' });

describe('diagnostics inventory over the Homey HTTP transport', () => {
  let server: http.Server;
  let respond: (response: http.ServerResponse) => void;
  let requests: { method?: string; path?: string; authorization?: string }[];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
      respond(response);
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address() as AddressInfo;
    await initHomeyHttpClient({
      homey: {
        api: {
          getOwnerApiToken: async () => 'test-token',
          getLocalUrl: async () => `http://127.0.0.1:${port}`,
        },
      },
    } as unknown as Homey.App);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  });

  beforeEach(() => { requests = []; });

  it('normalizes legacy fields and reconstructs UTF-8 split across HTTP chunks', async () => {
    const name = 'Frøya “💡”';
    const bytes = Buffer.from(JSON.stringify({
      'device-1': rawDevice('device-1', name),
      malformed: { id: 'malformed' },
    }));
    const split = bytes.indexOf(Buffer.from('💡')) + 1;
    respond = (response) => {
      response.write(bytes.subarray(0, split));
      setImmediate(() => response.end(bytes.subarray(split)));
    };
    await expect(readDevicesForDiagnostics(testLogger, collectDevices)).resolves.toEqual([
      expected('device-1', name),
    ]);
    expect(requests).toEqual([
      { method: 'GET', path: '/api/manager/devices/device', authorization: 'Bearer test-token' },
    ]);
  });

  it('accepts the legacy top-level device array', async () => {
    respond = (response) => response.end(JSON.stringify([rawDevice('relay'), rawDevice('meter')]));
    await expect(readDevicesForDiagnostics(testLogger, collectDevices)).resolves.toEqual([
      expected('relay'), expected('meter'),
    ]);
    expect(requests).toHaveLength(1);
  });

  it('keeps the normal buffered fetch contract', async () => {
    respond = (response) => response.end(JSON.stringify({
      relay: rawDevice('relay'), malformed: { id: 'malformed' },
    }));
    await expect(fetchDevicesWithFallback({ logger: testLogger })).resolves.toMatchObject({
      devices: [expected('relay')],
      failedIds: [],
      fetchSource: 'raw_manager_devices',
      rejectedPayloads: 1,
    });
    expect(requests).toHaveLength(1);
  });

  it('restarts projection after a partial successful-status response', async () => {
    const collector = vi.fn(collectDevices);
    respond = (response) => {
      const body = requests.length === 1
        ? `{"partial":${JSON.stringify(rawDevice('partial'))},"incomplete":`
        : JSON.stringify({ complete: rawDevice('complete') });
      response.end(body);
    };
    await expect(readDevicesForDiagnostics(testLogger, collector)).resolves.toEqual([expected('complete')]);
    expect(collector).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
  });

  it('retries when Homey disconnects mid-error response', async () => {
    const collector = vi.fn(collectDevices);
    respond = (response) => {
      if (requests.length !== 1) {
        response.end(JSON.stringify({ relay: rawDevice('relay') }));
        return;
      }
      response.writeHead(503);
      response.write('unavailable');
      setImmediate(() => response.destroy());
    };
    await expect(readDevicesForDiagnostics(testLogger, collector)).resolves.toEqual([expected('relay')]);
    expect(requests).toHaveLength(2);
    expect(collector).toHaveBeenCalledOnce();
  });

  it('keeps buffered enumeration semantics for unusual map keys', async () => {
    const collector = vi.fn(collectDevices);
    respond = (response) => {
      response.end(`{"relay":${JSON.stringify(rawDevice('obsolete'))},"relay":${JSON.stringify(rawDevice('relay'))},`
        + `"2":${JSON.stringify(rawDevice('second'))},"1":${JSON.stringify(rawDevice('first'))}}`);
    };
    await expect(readDevicesForDiagnostics(testLogger, collector)).resolves.toEqual([
      expected('first'), expected('second'), expected('relay'),
    ]);
    expect(collector).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
  });
});
