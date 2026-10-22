import { pairingLink, readPairing } from '../src/remote/phonePairing.ts';
import type { StoredHomey } from '../src/remote/remoteConnection.ts';

const HOMEY_ID = '65687b03c6bcab0c0a4464c3';
const OTHER_ID = '6acdea6cd18dc40482d6bc10';
const CLOUD = `https://${OTHER_ID}.homey.athom-prod-euwest1-001-shs.homeyshs.net`;
const LAUNCHER = 'https://pels.barelysufficient.org/app/';

const house: StoredHomey = {
  name: 'Hytta på fjellet',
  homeyId: HOMEY_ID,
  token: 'user:session:salt',
  baseUrl: `https://${HOMEY_ID}.connect.athom.com`,
  localUrl: 'https://192-168-1-50.homey.homeylocal.com',
};
const cabin: StoredHomey = { ...house, name: 'Cabin', homeyId: OTHER_ID, baseUrl: CLOUD, localUrl: null };

const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('phone pairing', () => {
  it('carries each Homey\'s name, key and cloud address to the phone, after the fragment', () => {
    const link = pairingLink(LAUNCHER, [house, cabin]);

    expect(link.startsWith(`${LAUNCHER}#pair=`)).toBe(true);
    // The phone learns the home-network address itself on first open.
    expect(readPairing(new URL(link).hash)).toEqual({
      state: 'homeys',
      homeys: [{ ...house, localUrl: null }, cabin],
    });
  });

  it('takes a name of 60 characters', () => {
    const named = { ...house, name: 'x'.repeat(60), localUrl: null };
    expect(readPairing(new URL(pairingLink(LAUNCHER, [named])).hash)).toEqual({ state: 'homeys', homeys: [named] });
  });

  it('reads nothing from an address without a code', () => {
    expect(readPairing('')).toEqual({ state: 'none' });
    expect(readPairing('#homey=abc')).toEqual({ state: 'none' });
  });

  // A code could be made by anyone, so it may only name Athom cloud addresses
  // for the Homeys it carries, as a pasted address may.
  it.each([
    ['a host that is not Athom\'s', [['House', 'u:s:t', 'https://attacker.example']]],
    ['a home-network address', [['House', 'u:s:t', 'https://192-168-1-50.homey.homeylocal.com']]],
    ['a malformed key', [['House', 'not-a-key', HOMEY_ID]]],
    ['an empty name', [['  ', 'u:s:t', HOMEY_ID]]],
    ['a name over 60 characters', [['x'.repeat(61), 'u:s:t', HOMEY_ID]]],
    ['the same Homey twice', [['House', 'u:s:t', HOMEY_ID], ['House 2', 'u:s:t', HOMEY_ID]]],
    ['one bad Homey among good ones', [['House', 'u:s:t', HOMEY_ID], ['Cabin', 'u:s:t', 'https://attacker.example']]],
    ['no Homeys', []],
    ['something else', { homeys: [] }],
  ])('refuses a code with %s', (_label, payload) => {
    expect(readPairing(`#pair=${encode(payload)}`)).toEqual({ state: 'unreadable' });
  });

  it('refuses a code that is cut off', () => {
    const link = pairingLink(LAUNCHER, [house]);
    expect(readPairing(new URL(link).hash.slice(0, 40))).toEqual({ state: 'unreadable' });
  });
});
