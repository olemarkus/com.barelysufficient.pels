import { decideLaunch, readHomeyVersion } from '../src/remote/launchDecision.ts';
import { RemoteHomeyError, type RemoteRequest } from '../src/remote/remoteHomeyClient.ts';

const HOMEY_ID = '65687b03c6bcab0c0a4464c3';
const CLOUD_HOST = `https://${HOMEY_ID}.homey.athom-prod-euwest1-001.homeypro.net`;

const answering = (outcome: unknown): RemoteRequest => vi.fn(async () => {
  if (outcome instanceof Error) throw outcome;
  return outcome;
});

describe('readHomeyVersion', () => {
  it('asks PELS for its version', async () => {
    const request = answering({ version: '3.20.0', timeZone: 'Europe/Oslo' });
    await expect(readHomeyVersion(request, HOMEY_ID)).resolves
      .toEqual({ state: 'version', version: '3.20.0', timeZone: 'Europe/Oslo', localUrl: null, cloudHost: null });
    expect(request).toHaveBeenCalledWith('GET', '/api/app/com.barelysufficient.pels/ui_version');
  });

  it('turns the reported home-network address into the secure one the browser can use', async () => {
    const request = answering({ version: '3.21.0', timeZone: 'Europe/Oslo', localAddress: '192.168.89.239:4859' });
    await expect(readHomeyVersion(request, HOMEY_ID)).resolves.toMatchObject({
      localUrl: 'https://192-168-89-239.homey.homeylocal.com:4860',
    });
  });

  it('takes the cloud host PELS learned only when it is this Homey\'s own', async () => {
    await expect(readHomeyVersion(answering({ version: '3.21.1', timeZone: 'Europe/Oslo', cloudHost: CLOUD_HOST }), HOMEY_ID))
      .resolves.toMatchObject({ cloudHost: CLOUD_HOST });
    const other = CLOUD_HOST.replace(HOMEY_ID, '6a1d4fbe841154c744299b7c');
    await expect(readHomeyVersion(answering({ version: '3.21.1', timeZone: 'Europe/Oslo', cloudHost: other }), HOMEY_ID))
      .resolves.toMatchObject({ cloudHost: null });
    await expect(readHomeyVersion(answering({ version: '3.21.1', timeZone: 'Europe/Oslo', cloudHost: 'https://example.com' }), HOMEY_ID))
      .resolves.toMatchObject({ cloudHost: null });
  });

  it('treats an answer without a timezone as unreadable', async () => {
    await expect(readHomeyVersion(answering({ version: '3.20.0' }), HOMEY_ID)).resolves
      .toEqual({ state: 'unreachable', detail: 'unexpected version answer' });
  });

  it.each([
    [new RemoteHomeyError('Cannot GET /api/app/com.barelysufficient.pels/ui_version', 404), { state: 'predates-web-app' }],
    [new RemoteHomeyError('Not Found: App with ID com.barelysufficient.pels', 404), { state: 'pels-missing' }],
    [new RemoteHomeyError('Missing Scopes', 403), { state: 'key-refused' }],
    [new RemoteHomeyError('Invalid Session', 401), { state: 'key-refused' }],
    [new RemoteHomeyError('App Not Ready', 503), { state: 'pels-not-running' }],
    [new RemoteHomeyError('Network request failed (offline)', 0), { state: 'unreachable', detail: 'Network request failed (offline)' }],
  ])('reads %s', async (error, expected) => {
    await expect(readHomeyVersion(answering(error), HOMEY_ID)).resolves.toEqual(expected);
  });
});

describe('decideLaunch', () => {
  const published = ['3.20.0', '3.20.1', '3.21.0'];

  it('opens the build of the version the Homey runs', () => {
    expect(decideLaunch({ state: 'version', version: '3.20.1', timeZone: 'Europe/Oslo', localUrl: null, cloudHost: null }, published))
      .toEqual({ state: 'open', version: '3.20.1' });
  });

  it('waits for the build of a release newer than every published one', () => {
    expect(decideLaunch({ state: 'version', version: '3.22.0', timeZone: 'Europe/Oslo', localUrl: null, cloudHost: null }, published))
      .toEqual({ state: 'build-not-published', version: '3.22.0' });
  });

  it('asks for a PELS update for a version without a build', () => {
    expect(decideLaunch({ state: 'version', version: '3.19.0', timeZone: 'Europe/Oslo', localUrl: null, cloudHost: null }, published))
      .toEqual({ state: 'update-pels', version: '3.19.0' });
  });

  it.each([
    { state: 'predates-web-app' },
    { state: 'pels-missing' },
    { state: 'pels-not-running' },
    { state: 'key-refused' },
    { state: 'unreachable', detail: 'timeout' },
  ] as const)('passes $state through', (read) => {
    expect(decideLaunch(read, published)).toEqual(read);
  });
});
