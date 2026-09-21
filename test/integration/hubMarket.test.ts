import { readHubMarket } from '../../lib/home/hubMarket';
import { homeyWebApiServing, unreachableHomeyWebApi } from '../helpers/homeyWebApiStub';

// The read crosses the Homey Web API seam, so it lives here rather than beside
// the pure classifier in `test/unit/hubMarket.test.ts`.
describe('reading the hub market over the Homey Web API', () => {
  it('asks the system manager, on the exact path the real API serves', async () => {
    // Verified against a real hub: `/api/manager/system`, no trailing slash.
    const api = homeyWebApiServing({
      'manager/system': { country: 'NL', language: 'en', timezone: 'Europe/Amsterdam' },
    });
    await expect(readHubMarket(api.get)).resolves.toEqual({ state: 'resolved', country: 'NL' });
    expect(api.requestedPaths).toEqual(['manager/system']);
  });

  it('owns a route the hub does not serve', async () => {
    await expect(readHubMarket(homeyWebApiServing({}).get)).resolves.toEqual({ state: 'unavailable' });
  });

  it('owns an unreachable hub: nothing throws, and no country is guessed', async () => {
    await expect(readHubMarket(unreachableHomeyWebApi)).resolves.toEqual({ state: 'unavailable' });
  });
});
