import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { HomeyReportTransport } from '../../lib/diagnostics/homeyReportTransport';
import { httpResponse } from '../helpers/httpResponse';

const homey = () => ({
  manifest: { id: 'com.barelysufficient.pels' },
  api: {
    getOwnerApiToken: vi.fn(async () => 'test-token'),
    getLocalUrl: vi.fn(async () => 'http://homey.test'),
  },
});

describe('Homey diagnostic transport', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('uses the manager endpoint with owner authentication and exactly one message field', async () => {
    fetchMock.mockResolvedValue(httpResponse({ id: 'diagnostic-123' }));
    const sender = new HomeyReportTransport(homey());
    expect(await sender.send('PELS report\nø')).toEqual({ state: 'accepted', reference: 'diagnostic-123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://homey.test/api/manager/apps/app/com.barelysufficient.pels/crashlog');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(options?.body))).toEqual({ message: 'PELS report\nø' });
  });

  it.each([
    [{ origin: 'appstore' }, 'available'], [{ origin: 'local' }, 'app_store_required'],
    [{}, 'unavailable'], [null, 'unavailable'],
  ] as const)('resolves installation availability from %j', async (body, expected) => {
    fetchMock.mockResolvedValue(httpResponse(body));
    expect(await new HomeyReportTransport(homey()).availability()).toBe(expected);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://homey.test/api/manager/apps/app/com.barelysufficient.pels');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('GET');
  });

  it.each([400, 401, 403, 413])('treats an explicit HTTP %s refusal as rejected', async (status) => {
    fetchMock.mockResolvedValue(httpResponse('Refused', status));
    expect(await new HomeyReportTransport(homey()).send('report')).toEqual({ state: 'rejected' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves uncertainty after a lost response or server error, without retrying', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection lost'));
    const sender = new HomeyReportTransport(homey());
    expect(await sender.send('report')).toEqual({ state: 'unknown' });
    fetchMock.mockResolvedValueOnce(httpResponse('Internal error', 500));
    expect(await sender.send('report')).toEqual({ state: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds the complete request, including an unresponsive authentication read', async () => {
    vi.useFakeTimers();
    const runtime = homey();
    let finish!: (token: string) => void;
    runtime.api.getOwnerApiToken.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = new HomeyReportTransport(runtime).send('report');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await pending).toEqual({ state: 'unknown' });
    finish('late-token');
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a request whose response body never finishes', async () => {
    vi.useFakeTimers();
    const response = httpResponse(null);
    response.text = () => new Promise(() => {});
    fetchMock.mockResolvedValue(response);
    const pending = new HomeyReportTransport(homey()).send('report');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await pending).toEqual({ state: 'unknown' });
    const signal = fetchMock.mock.calls[0]![1]?.signal;
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
