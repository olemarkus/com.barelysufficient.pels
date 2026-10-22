import { cloudAddressFor, localUrlFromAddress, parseHomeyAddress } from '../src/remote/homeyAddress.ts';
import {
  findStoredHomey,
  learnCloudUrl,
  learnLocalUrl,
  loadStoredHomeys,
  markLastHomey,
  pickBuildHomeyId,
  removeStoredHomey,
  saveStoredHomey,
  type StoredHomey,
} from '../src/remote/remoteConnection.ts';

const HOMEY_ID = '65687b03c6bcab0c0a4464c3';
const OTHER_ID = '6acdea6cd18dc40482d6bc10';

const homey = (overrides: Partial<StoredHomey> = {}): StoredHomey => ({
  name: 'House',
  baseUrl: `https://${HOMEY_ID}.connect.athom.com`,
  homeyId: HOMEY_ID,
  token: 'user:session:salt',
  localUrl: null,
  ...overrides,
});

const RELAY = `https://${HOMEY_ID}.connect.athom.com`;
const CLOUD = `https://${HOMEY_ID}.homey.athom-prod-euwest1-001.homeypro.net`;

describe('parseHomeyAddress', () => {
  it.each([
    [HOMEY_ID, RELAY],
    [`https://my.homey.app/homeys/${HOMEY_ID}/settings/apps`, RELAY],
    [`${RELAY}/`, RELAY],
    [`${CLOUD}/`, CLOUD],
    [`https://${OTHER_ID}.homey.athom-prod-euwest1-001-shs.homeyshs.net`, `https://${OTHER_ID}.homey.athom-prod-euwest1-001-shs.homeyshs.net`],
  ])('reads %s as a cloud address', (input, baseUrl) => {
    const homeyId = new URL(baseUrl).hostname.split('.')[0];
    expect(parseHomeyAddress(input)).toEqual({ kind: 'cloud', baseUrl, homeyId });
  });

  it('reads a home-network address, whose Homey a ping names', () => {
    expect(parseHomeyAddress('https://192-168-1-50.homey.homeylocal.com:4860/'))
      .toEqual({ kind: 'local', baseUrl: 'https://192-168-1-50.homey.homeylocal.com:4860' });
  });

  // An API key goes wherever the address leads, so nothing but the owner's
  // Homey passes: no other host, no plain HTTP, no public or odd-port address.
  it.each([
    '', 'not an address', 'https://my.homey.app/', 'ftp://192.168.1.50',
    'https://nope.connect.athom.com', 'https://nope.homey.athom-prod-euwest1-001.homeypro.net',
    'https://attacker.example', 'http://192.168.1.50', 'https://192.168.1.50',
    'http://192-168-1-50.homey.homeylocal.com', 'https://8-8-8-8.homey.homeylocal.com',
    'https://192-168-1-50.homey.homeylocal.com:8443',
  ])('refuses %j', (input) => {
    expect(parseHomeyAddress(input)).toBeNull();
  });
});

describe('cloudAddressFor', () => {
  // It reads links, so nothing but an Athom host named for this Homey passes.
  it('accepts this Homey\'s own cloud host and the relay', () => {
    expect(cloudAddressFor(CLOUD, HOMEY_ID)).toBe(CLOUD);
    expect(cloudAddressFor(`${RELAY}/x`, HOMEY_ID)).toBe(RELAY);
  });

  it.each([
    `https://${OTHER_ID}.homey.athom-prod-euwest1-001.homeypro.net`,
    `http://${HOMEY_ID}.homey.athom-prod-euwest1-001.homeypro.net`,
    `https://${HOMEY_ID}.homey.athom-prod-euwest1-001.homeypro.net.evil.example`,
    `https://${HOMEY_ID}.evil.example`,
    'https://192-168-1-50.homey.homeylocal.com',
    'not a url',
  ])('ignores %s', (origin) => {
    expect(cloudAddressFor(origin, HOMEY_ID)).toBeNull();
  });
});

describe('localUrlFromAddress', () => {
  it.each([
    ['192.168.89.239:4859', 'https://192-168-89-239.homey.homeylocal.com:4860'],
    ['192.168.89.241:80', 'https://192-168-89-241.homey.homeylocal.com'],
    ['10.0.0.5', 'https://10-0-0-5.homey.homeylocal.com'],
    ['172.20.1.2:80', 'https://172-20-1-2.homey.homeylocal.com'],
  ])('gives %s the secure address the Athom account lists', (address, url) => {
    expect(localUrlFromAddress(address)).toBe(url);
  });

  it.each([null, undefined, '', 'homey.local:80', '8.8.8.8:80', '192.168.1.300', '192.168.1.5:8080'])(
    'has no usable address for %j',
    (address) => {
      expect(localUrlFromAddress(address)).toBeNull();
    },
  );
});

describe('stored Homeys', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps several Homeys and replaces one added again with a new key', () => {
    saveStoredHomey(window.localStorage, homey());
    saveStoredHomey(window.localStorage, homey({ name: 'Cabin', homeyId: OTHER_ID }));
    saveStoredHomey(window.localStorage, homey({ token: 'user:session2:salt2' }));

    const { homeys } = loadStoredHomeys(window.localStorage);
    expect(homeys.map((entry) => entry.name).sort()).toEqual(['Cabin', 'House']);
    expect(findStoredHomey(window.localStorage, HOMEY_ID)?.token).toBe('user:session2:salt2');
  });

  it('forgets the last opened Homey when it is removed', () => {
    saveStoredHomey(window.localStorage, homey());
    markLastHomey(window.localStorage, HOMEY_ID);
    expect(loadStoredHomeys(window.localStorage).lastHomeyId).toBe(HOMEY_ID);

    removeStoredHomey(window.localStorage, HOMEY_ID);
    expect(loadStoredHomeys(window.localStorage)).toEqual({ homeys: [], lastHomeyId: null });
  });

  it('keeps a Homey in its place when it is saved again', () => {
    saveStoredHomey(window.localStorage, homey());
    saveStoredHomey(window.localStorage, homey({ name: 'Cabin', homeyId: OTHER_ID }));
    saveStoredHomey(window.localStorage, homey({ name: 'House again' }));

    expect(loadStoredHomeys(window.localStorage).homeys.map((entry) => entry.name)).toEqual(['House again', 'Cabin']);
  });

  it('learns a better address, and keeps the old one when the Homey reports none', () => {
    saveStoredHomey(window.localStorage, homey());
    learnLocalUrl(window.localStorage, HOMEY_ID, 'https://10-0-0-5.homey.homeylocal.com');
    learnLocalUrl(window.localStorage, HOMEY_ID, null);
    learnCloudUrl(window.localStorage, HOMEY_ID, CLOUD);

    expect(findStoredHomey(window.localStorage, HOMEY_ID))
      .toEqual(homey({ baseUrl: CLOUD, localUrl: 'https://10-0-0-5.homey.homeylocal.com' }));
  });

  it('answers with the stored record when the browser refuses to keep a learned address', () => {
    saveStoredHomey(window.localStorage, homey());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(learnLocalUrl(window.localStorage, HOMEY_ID, 'https://10-0-0-5.homey.homeylocal.com')).toEqual(homey());
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps a key saved while an address was being learned', () => {
    saveStoredHomey(window.localStorage, homey());
    saveStoredHomey(window.localStorage, homey({ token: 'user:newer:key' }));

    learnLocalUrl(window.localStorage, HOMEY_ID, 'https://10-0-0-5.homey.homeylocal.com');

    expect(findStoredHomey(window.localStorage, HOMEY_ID)?.token).toBe('user:newer:key');
  });

  it('drops a stored address that does not lead to this Homey', () => {
    window.localStorage.setItem('pels.webapp.homeys.v1', JSON.stringify({
      homeys: [{ ...homey(), baseUrl: 'https://attacker.example', localUrl: 'https://attacker.example' }],
      lastHomeyId: HOMEY_ID,
    }));

    expect(findStoredHomey(window.localStorage, HOMEY_ID)).toEqual(homey({ baseUrl: RELAY, localUrl: null }));
  });

  it('moves a home-network address stored as the only address over to localUrl', () => {
    window.localStorage.setItem('pels.webapp.homeys.v1', JSON.stringify({
      homeys: [{ name: 'House', baseUrl: 'https://192-168-1-50.homey.homeylocal.com', homeyId: HOMEY_ID, token: 'u:s:t' }],
      lastHomeyId: HOMEY_ID,
    }));

    expect(findStoredHomey(window.localStorage, HOMEY_ID)).toEqual({
      name: 'House',
      homeyId: HOMEY_ID,
      token: 'u:s:t',
      baseUrl: RELAY,
      localUrl: 'https://192-168-1-50.homey.homeylocal.com',
    });
  });

  it('drops a malformed entry without losing the others', () => {
    window.localStorage.setItem('pels.webapp.homeys.v1', JSON.stringify({
      homeys: [homey(), { ...homey({ homeyId: OTHER_ID }), token: 'not-a-key' }],
      lastHomeyId: OTHER_ID,
    }));
    expect(loadStoredHomeys(window.localStorage)).toEqual({ homeys: [homey()], lastHomeyId: null });
  });

  it('reports a write the browser refuses', () => {
    const refusing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } } as unknown as Storage;
    expect(saveStoredHomey(refusing, homey())).toBe(false);
    expect(saveStoredHomey(null, homey())).toBe(false);
    expect(saveStoredHomey(window.localStorage, homey())).toBe(true);
  });

  it('starts empty when storage is unavailable or holds junk', () => {
    expect(loadStoredHomeys(null)).toEqual({ homeys: [], lastHomeyId: null });
    window.localStorage.setItem('pels.webapp.homeys.v1', '{not json');
    expect(loadStoredHomeys(window.localStorage)).toEqual({ homeys: [], lastHomeyId: null });
  });
});

describe('pickBuildHomeyId', () => {
  // The settings UI's own navigation drops the `#homey=` fragment, so a tab
  // keeps its Homey across navigations and reloads; a new tab gets the last one.
  const stored = { homeys: [homey(), homey({ name: 'Cabin', homeyId: OTHER_ID })], lastHomeyId: HOMEY_ID };

  it('prefers the fragment, then the tab, then the Homey opened last', () => {
    expect(pickBuildHomeyId(OTHER_ID, HOMEY_ID, stored)).toBe(OTHER_ID);
    expect(pickBuildHomeyId(null, OTHER_ID, stored)).toBe(OTHER_ID);
    expect(pickBuildHomeyId(null, null, stored)).toBe(HOMEY_ID);
  });

  it('skips a Homey that is no longer listed', () => {
    expect(pickBuildHomeyId('ffffffffffffffffffffffff', OTHER_ID, stored)).toBe(OTHER_ID);
    expect(pickBuildHomeyId(null, null, { homeys: [], lastHomeyId: null })).toBeNull();
  });
});
