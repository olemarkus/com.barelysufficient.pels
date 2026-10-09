import http from 'http';
import type { AddressInfo } from 'net';
import type Homey from 'homey';
import type { MockInstance } from 'vitest';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { initHomeyHttpClient, setRawCapabilityValue } from '../../lib/device/transport/managerHomeyApi';

/**
 * The caller's deadline is not the point at which PELS stops listening.
 *
 * A cloud-backed device's owning app can take far longer than the request
 * deadline to answer, and that answer is the only place its real failure is
 * ever visible. Destroying the socket at our own deadline is what kept
 * myUplink's `HTTP 500 "Failed to change the settings."` out of every
 * production log while 28 of 29 write failures filed as bare timeouts.
 */
describe('Homey HTTP transport — answers that arrive after the caller gave up', () => {
  let logCapture: LoggerCapture;
  let requestSpy: MockInstance<typeof http.request>;
  let server: http.Server;
  // The hub's behaviour for the current test. The transport connects once per
  // process, as it does in production, so one server serves every test.
  let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => respond(req, res));
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

  beforeEach(() => {
    logCapture = captureLogger();
    // The real deadline is far too long to drive a socket test against, and
    // `timeout` is Node's socket-idle timer, which fake timers do not reach.
    // Shorten it on the way out instead: far below any real answer, so the
    // caller gives up while the server is still holding the response.
    const realRequest = http.request;
    requestSpy = vi.spyOn(http, 'request').mockImplementation(((
      options: http.RequestOptions,
      callback?: (res: http.IncomingMessage) => void,
    ) => realRequest({ ...options, timeout: 60 }, callback)) as typeof http.request);
  });

  afterEach(() => {
    requestSpy.mockRestore();
    logCapture.restore();
  });

  it('records the owning app\'s real error when it arrives after the timeout', async () => {
    respond = (_req, res) => {
      setTimeout(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to change the settings.' }));
      }, 250);
    };

    // The control path is told the outcome is unknown, promptly.
    await expect(setRawCapabilityValue('dev-1', 'max_power_3000', '2')).rejects.toThrow(/timed out/);

    // ...and the answer is still recorded when the hub finally produces it.
    await vi.waitFor(() => {
      expect(logCapture.events).toContainEqual(expect.objectContaining({
        event: 'homey_request_late_response',
        reasonCode: 'failed_after_abandon',
        statusCode: 500,
        method: 'PUT',
        responseBody: expect.stringContaining('Failed to change the settings.'),
      }));
    }, { timeout: 3_000 });
  });

  it('distinguishes a write that LANDED after PELS stopped waiting', async () => {
    respond = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: '2' }));
      }, 250);
    };

    await expect(setRawCapabilityValue('dev-1', 'max_power_3000', '2')).rejects.toThrow(/timed out/);

    // A late 2xx is the one fact an unknown outcome cannot otherwise learn: the
    // hub was slow, not refusing, and the device did move.
    await vi.waitFor(() => {
      expect(logCapture.events).toContainEqual(expect.objectContaining({
        event: 'homey_request_late_response',
        reasonCode: 'landed_after_abandon',
        statusCode: 200,
      }));
    }, { timeout: 3_000 });
  });

  it('does not log a late outcome for a request that answers in time', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: '2' }));
    };

    await expect(setRawCapabilityValue('dev-1', 'max_power_3000', '2')).resolves.toBeUndefined();
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'homey_request_late_response',
    }));
  });
});
