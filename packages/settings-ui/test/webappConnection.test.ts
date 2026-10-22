import {
  findStoredHomey,
  loadStoredHomeys,
  markLastHomey,
  parseHomeyAddress,
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
  ...overrides,
});

describe('parseHomeyAddress', () => {
  it.each([
    [HOMEY_ID, `https://${HOMEY_ID}.connect.athom.com`, HOMEY_ID],
    [`https://my.homey.app/homeys/${HOMEY_ID}/settings/apps`, `https://${HOMEY_ID}.connect.athom.com`, HOMEY_ID],
    [`https://${HOMEY_ID}.connect.athom.com/`, `https://${HOMEY_ID}.connect.athom.com`, HOMEY_ID],
    ['https://192-168-1-50.homey.homeylocal.com:4860/', 'https://192-168-1-50.homey.homeylocal.com:4860', null],
  ])('reads %s', (input, baseUrl, homeyId) => {
    expect(parseHomeyAddress(input)).toEqual({ baseUrl, homeyId });
  });

  it.each(['', 'not an address', 'https://my.homey.app/', 'ftp://192.168.1.50'])('refuses %j', (input) => {
    expect(parseHomeyAddress(input)).toBeNull();
  });
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
