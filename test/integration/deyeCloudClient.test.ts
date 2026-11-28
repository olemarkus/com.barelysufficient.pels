import { DeyeCloudClient, type DeyeCloudCredentials } from '../../lib/actuator/deyeCloudClient';

const credentials: DeyeCloudCredentials = {
  region: 'eu',
  appId: 'app-id',
  appSecret: 'app-secret',
  email: 'owner@example.invalid',
  passwordHash: 'a'.repeat(64),
  deviceSn: 'SYNTHETIC123',
};

const id = '9223372036854775807';

function jsonResponse(body: string): Awaited<ReturnType<typeof fetch>> {
  return { ok: true, status: 200, text: async () => body } as Awaited<ReturnType<typeof fetch>>;
}

function setup() {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(
    '{"success":true,"accessToken":"Bearer sample-token","expiresIn":"3600"}',
  ));
  return { fetchImpl, client: new DeyeCloudClient(fetchImpl) };
}

describe('Deye Cloud client', () => {
  it('reads the limit and carries a numeric int64 order ID into the exact confirmation request', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse('{"success":true,"maxDischargeCurrent":50}'))
      .mockResolvedValueOnce(jsonResponse(`{"success":true,"orderId":${id}}`))
      .mockResolvedValueOnce(jsonResponse(`{"success":true,"status":666,"orderId":${id}}`));

    await expect(client.readLimit(credentials)).resolves.toBe(50);
    const write = await client.prepareLimitWrite(credentials, 0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(write()).resolves.toEqual({ kind: 'submitted', orderId: id });
    await expect(client.readOrder(credentials, id)).resolves.toBe('succeeded');

    const origin = 'https://eu1-developer.deyecloud.com';
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, new URL('/v1.0/account/token?appId=app-id', origin),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ appSecret: credentials.appSecret, email: credentials.email, password: 'a'.repeat(64) }),
        redirect: 'error',
      }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, new URL('/v1.0/config/battery', origin), expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sample-token' }),
      body: JSON.stringify({ deviceSn: credentials.deviceSn }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(3, new URL('/v1.0/order/battery/parameter/update', origin),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ deviceSn: credentials.deviceSn, paramterType: 'MAX_DISCHARGE_CURRENT', value: 0 }),
      }));
    expect(fetchImpl).toHaveBeenNthCalledWith(4, new URL(`/v1.0/order/${id}`, origin), expect.objectContaining({
      method: 'GET',
    }));
  });

  it.each([
    [0, 'pending'], [100, 'pending'], [300, 'pending'], [400, 'failed'], [500, 'failed'],
  ])('maps order status %i to %s independently of the successful HTTP response', async (status, expected) => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(jsonResponse(JSON.stringify({ success: true, orderId: id, status })));
    await expect(client.readOrder(credentials, id)).resolves.toBe(expected);
  });

  it.each([
    { orderId: '7', status: 666 },
    { orderId: id, status: 200 },
    { orderId: id, status: '666' },
    { orderId: id, status: 666, success: false },
  ])('cannot confirm an unrelated, unknown or unsuccessful order result (%j)', async (result) => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(jsonResponse(JSON.stringify({ success: true, ...result })));
    await expect(client.readOrder(credentials, id)).rejects.toThrow('Deye Cloud');
  });

  it('returns an ambiguous failure after the write POST loses its response', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockRejectedValueOnce(new Error(`Connection timed out while sending ${credentials.appSecret}`));
    await expect((await client.prepareLimitWrite(credentials, 0))()).rejects.toThrow('Deye Cloud request could not be confirmed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])('distinguishes a rejected write (%i) from a lost response', async (status) => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce({ ok: false, status } as Awaited<ReturnType<typeof fetch>>);
    const submit = await client.prepareLimitWrite(credentials, 0);
    await expect(submit()).resolves.toEqual({ kind: 'authorization_rejected' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('requires an order ID to confirm cloud acceptance', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(jsonResponse('{"success":true,"orderId":9223372036854775808}'));
    await expect((await client.prepareLimitWrite(credentials, 0))()).rejects.toThrow('Missing Deye Cloud order ID');
  });

  it('does not use a missing or malformed baseline as a discharge limit', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(jsonResponse('{"success":true,"maxDischargeCurrent":"50"}'));
    await expect(client.readLimit(credentials)).rejects.toThrow('Invalid Deye Cloud discharge current');
  });
});
