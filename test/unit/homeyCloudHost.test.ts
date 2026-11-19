import { describe, expect, it } from 'vitest';
import { cloudHostHomeyId, ownCloudHostFor } from '../../packages/shared-domain/src/homeyCloudHost';

// The rule both PELS and the web app hold a cloud address to: an API key goes
// wherever it is sent, so only an Athom host named for that very Homey counts.
describe('a Homey\'s own cloud host', () => {
  const HOMEY_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

  it.each([
    `https://${HOMEY_ID}.homey.fixture.homeypro.net`,
    `https://${HOMEY_ID}.homey.fixture.homeyshs.net`,
  ])('takes %s', (origin) => {
    expect(ownCloudHostFor(`${origin}/app/com.barelysufficient.pels/settings/`, HOMEY_ID)).toBe(origin);
    expect(ownCloudHostFor(origin.toUpperCase().replace('HTTPS', 'https'), HOMEY_ID)).toBe(origin);
  });

  it.each([
    ['another Homey\'s host', 'https://cccccccccccccccccccccccc.homey.fixture.homeypro.net'],
    ['plain http', `http://${HOMEY_ID}.homey.fixture.homeypro.net`],
    ['a port', `https://${HOMEY_ID}.homey.fixture.homeypro.net:8443`],
    ['the relay', `https://${HOMEY_ID}.connect.athom.com`],
    ['a look-alike domain', `https://${HOMEY_ID}.homey.x.homeypro.net.evil.example`],
    ['junk', 'not a url'],
  ])('refuses %s', (_label, origin) => {
    expect(ownCloudHostFor(origin, HOMEY_ID)).toBeNull();
  });

  it('names the Homey a cloud host belongs to', () => {
    expect(cloudHostHomeyId(`${HOMEY_ID}.homey.fixture.homeypro.net`)).toBe(HOMEY_ID);
    expect(cloudHostHomeyId('pels.barelysufficient.org')).toBeNull();
  });
});
