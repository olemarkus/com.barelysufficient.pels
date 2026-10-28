import { athomReviewChanges } from '../../scripts/lib/athom-review.mjs';

const manifest = {
  version: '3.20.0',
  permissions: ['homey:manager:api'],
  api: { ui_version: { method: 'GET', path: '/ui_version' } },
  flow: { actions: [{ id: 'set_capacity_mode', title: { en: 'Set mode' } }] },
  drivers: [{ id: 'pels_insights', name: { en: 'PELS Insights' } }],
  description: { en: 'Energy manager' },
};

const check = (headManifest: Record<string, unknown>, changedFiles: string[] = []) =>
  athomReviewChanges({ baseManifest: manifest, headManifest, changedFiles });

describe('Athom review surface', () => {
  it('lets a version-only bump release without review', () => {
    expect(check({ ...manifest, version: '3.20.1' }, ['app.json', '.homeychangelog.json'])).toEqual([]);
  });

  it('names added, removed and changed API routes', () => {
    expect(check({
      ...manifest,
      api: {
        ui_version: { method: 'POST', path: '/ui_version' },
        support_report_get: { method: 'GET', path: '/support-report/:id' },
      },
    })).toEqual(['api: added support_report_get', 'api: changed ui_version']);
    expect(check({ ...manifest, api: {} })).toEqual(['api: removed ui_version']);
  });

  it('names flow card, driver and permission changes by id', () => {
    expect(check({
      ...manifest,
      permissions: ['homey:manager:api', 'homey:manager:geolocation'],
      flow: { actions: [{ id: 'set_capacity_mode', title: { en: 'Set capacity mode' } }], triggers: [{ id: 'x' }] },
      drivers: [],
    })).toEqual([
      'drivers: removed pels_insights',
      'flow actions: changed set_capacity_mode',
      'flow triggers: added x',
      'permissions: added homey:manager:geolocation',
    ]);
  });

  it('ignores key order inside an unchanged object', () => {
    expect(check({ ...manifest, api: { ui_version: { path: '/ui_version', method: 'GET' } } })).toEqual([]);
  });

  it('flags other manifest fields and store page files', () => {
    expect(check({ ...manifest, description: { en: 'Home energy manager' } }, [
      'README.nl.txt',
      'assets/images/large.png',
      'assets/fonts/inter.woff2',
      'assets/icon.svg.bak',
      'drivers/pels_insights/assets/icon.svg',
      'widgets/device/preview-dark.png',
      'widgets/device/public/index.html',
    ])).toEqual([
      'app.json: changed description',
      'store page: README.nl.txt',
      'store page: assets/images/large.png',
      'store page: drivers/pels_insights/assets/icon.svg',
      'store page: widgets/device/preview-dark.png',
    ]);
  });
});
