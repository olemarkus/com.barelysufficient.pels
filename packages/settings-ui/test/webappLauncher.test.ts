import fs from 'node:fs';
import path from 'node:path';

// The launcher page wired to fake Homey answers. Homey 404s a route PELS does
// not have before it checks the key, so on a PELS from before the web app the
// version read cannot vouch for a key: the add form must check it on its own.

const HOMEY_ID = '65687b03c6bcab0c0a4464c3';
const KEY_CHECK_PATH = '/api/manager/apps/app/com.barelysufficient.pels/setting/web_app_key_check';
const VERSION_PATH = '/api/app/com.barelysufficient.pels/ui_version';

type TextField = HTMLElement & { value: string; error: boolean; errorText: string };

const response = (status: number, body: string) => new Response(body, { status });

let publishedVersions = '["3.20.0"]';

const loadLauncher = async (homey: (pathname: string, url: URL) => Response, ready: () => void = () => {
  expect(document.getElementById('webapp-add-panel')?.hidden).toBe(false);
}) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'webapp-launcher.html'), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script').forEach((script) => script.remove());
  document.body.innerHTML = parsed.body.innerHTML;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === 'versions.json') return response(200, publishedVersions);
    const url = new URL(input);
    return homey(url.pathname, url);
  }));
  vi.resetModules();
  await import('../src/remote/launcherEntry.ts');
  await vi.waitFor(ready);
};

const submitHomey = async () => {
  const form = document.getElementById('webapp-add-form') as HTMLFormElement;
  (form.querySelector('[name="name"]') as TextField).value = 'House';
  (form.querySelector('[name="address"]') as TextField).value = HOMEY_ID;
  (form.querySelector('[name="key"]') as TextField).value = 'user:session:salt';
  form.requestSubmit();
};

const keyField = () => document.querySelector('#webapp-add-form [name="key"]') as TextField;
const storedNames = () => (
  JSON.parse(window.localStorage.getItem('pels.webapp.homeys.v1') ?? '{"homeys":[]}') as { homeys: { name: string }[] }
).homeys.map((homey) => homey.name);

describe('web app launcher', () => {
  beforeEach(() => {
    window.localStorage.clear();
    publishedVersions = '["3.20.0"]';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses a key Homey rejects, even when PELS predates the version route', async () => {
    await loadLauncher((pathname) => (pathname === KEY_CHECK_PATH
      ? response(401, '{"error":"Invalid Session"}')
      : response(404, `<pre>Cannot GET ${VERSION_PATH}</pre>`)));

    await submitHomey();

    await vi.waitFor(() => expect(keyField().error).toBe(true));
    expect(keyField().errorText).toBe('Homey refused this key. Check that it may control apps.');
    expect(storedNames()).toEqual([]);
  });

  it('adds a Homey whose key is accepted and lists it with its PELS version', async () => {
    await loadLauncher((pathname) => (pathname === KEY_CHECK_PATH
      ? response(200, 'null')
      : response(200, '{"version":"3.20.0","timeZone":"Europe/Oslo"}')));

    await submitHomey();

    await vi.waitFor(() => expect(storedNames()).toEqual(['House']));
    await vi.waitFor(() => expect(document.getElementById('webapp-homey-list')?.textContent).toContain('PELS 3.20.0'));
  });

  it('keeps the form open when the browser refuses to store the Homey', async () => {
    await loadLauncher(() => response(200, 'null'));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    await submitHomey();

    const nameField = document.querySelector('#webapp-add-form [name="name"]') as TextField;
    await vi.waitFor(() => expect(nameField.error).toBe(true));
    expect(document.getElementById('webapp-add-panel')?.hidden).toBe(false);
    expect(document.getElementById('webapp-homey-list')?.children).toHaveLength(0);
  });

  it('finds a build published after the page loaded when checked again', async () => {
    window.localStorage.setItem('pels.webapp.homeys.v1', JSON.stringify({
      homeys: [{ name: 'House', baseUrl: `https://${HOMEY_ID}.connect.athom.com`, homeyId: HOMEY_ID, token: 'u:s:t' }],
      lastHomeyId: null,
    }));
    publishedVersions = '["3.19.0"]';
    const list = () => document.getElementById('webapp-homey-list')?.textContent ?? '';
    await loadLauncher(
      () => response(200, '{"version":"3.20.0","timeZone":"Europe/Oslo"}'),
      () => expect(list()).toContain('newer than the web app'),
    );

    publishedVersions = '["3.19.0","3.20.0"]';
    const checkAgain = [...document.querySelectorAll('md-text-button')]
      .find((element) => element.textContent === 'Check again') as HTMLElement;
    checkAgain.click();

    await vi.waitFor(() => expect(list()).toContain('PELS 3.20.0'));
  });

  // Where an API key is sent must come from the owner: a crafted link naming
  // someone else's Homey must not be able to collect keys.
  it.each(['add', 'open'])('never fills in the add form from ?%s=', async (param) => {
    window.history.replaceState(null, '', `/?${param}=${HOMEY_ID}`);
    try {
      await loadLauncher(() => response(200, 'null'));
      const addressField = document.querySelector('#webapp-add-form [name="address"]') as TextField;
      expect(addressField.value).toBe('');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  describe('choosing where to reach a Homey', () => {
    const CLOUD = `https://${HOMEY_ID}.homey.athom-prod-euwest1-001.homeypro.net`;
    const LOCAL = 'https://192-168-1-50.homey.homeylocal.com';
    const stored = () => JSON.parse(window.localStorage.getItem('pels.webapp.homeys.v1') ?? '{}') as {
      homeys: { baseUrl: string; localUrl?: string | null }[];
    };
    const listHouse = (localUrl: string | null) => window.localStorage.setItem('pels.webapp.homeys.v1', JSON.stringify({
      homeys: [{ name: 'House', baseUrl: `https://${HOMEY_ID}.connect.athom.com`, homeyId: HOMEY_ID, token: 'u:s:t', localUrl }],
      lastHomeyId: HOMEY_ID,
    }));
    // The build path and the address choice handed to it in this tab.
    const openWith = async (search: string, homey: (pathname: string, url: URL) => Response) => {
      const assign = vi.fn();
      vi.stubGlobal('location', { ...window.location, search, assign });
      await loadLauncher(homey, () => expect(assign).toHaveBeenCalled());
      const handed = JSON.parse(window.sessionStorage.getItem('pels.webapp.addressChoice') ?? 'null') as
        { baseUrl: string } | null;
      const address = handed?.baseUrl.includes('homeylocal') ? 'local' : 'cloud';
      return `${String(assign.mock.calls[0]?.[0])} ${address}`;
    };
    beforeEach(() => window.sessionStorage.clear());
    const version = (localAddress: string | null) => response(
      200,
      JSON.stringify({ version: '3.20.0', timeZone: 'Europe/Oslo', homeyId: HOMEY_ID, localAddress }),
    );

    it('switches a listed Homey to the cloud host the PELS settings page links with', async () => {
      listHouse(null);
      const hosts: string[] = [];
      await openWith(`?open=${HOMEY_ID}&via=${encodeURIComponent(CLOUD)}`, (pathname, url) => {
        hosts.push(`${url.origin}${pathname}`);
        return pathname === '/api/manager/system/ping' ? response(200, '') : version(null);
      });

      expect(stored().homeys[0]?.baseUrl).toBe(CLOUD);
      expect(hosts).toEqual([`${CLOUD}/api/manager/system/ping`, `${CLOUD}${VERSION_PATH}`]);
    });

    it('keeps the relay when the linked cloud host does not answer', async () => {
      listHouse(null);
      await openWith(`?open=${HOMEY_ID}&via=${encodeURIComponent(CLOUD)}`, (pathname, url) => (
        url.origin === CLOUD ? response(502, '') : version(null)
      ));

      expect(stored().homeys[0]?.baseUrl).toBe(`https://${HOMEY_ID}.connect.athom.com`);
    });

    it('ignores a linked host that is not this Homey\'s', async () => {
      listHouse(null);
      await openWith(`?open=${HOMEY_ID}&via=${encodeURIComponent('https://evil.example')}`, () => version(null));

      expect(stored().homeys[0]?.baseUrl).toBe(`https://${HOMEY_ID}.connect.athom.com`);
    });

    it('keeps the home-network address the Homey reports, and tries it before opening', async () => {
      listHouse(null);
      const path = await openWith('', (pathname) => (pathname === '/api/manager/system/ping'
        ? new Response('', { status: 200, headers: { 'X-Homey-ID': HOMEY_ID } })
        : version('192.168.1.50:80')));

      expect(stored().homeys[0]?.localUrl).toBe(LOCAL);
      expect(path).toBe(`v3.20.0/#homey=${HOMEY_ID} local`);
    });

    it('opens on the home network when this Homey answers there', async () => {
      listHouse(LOCAL);
      const hosts: string[] = [];
      const path = await openWith('', (pathname, url) => {
        hosts.push(url.origin);
        if (pathname === '/api/manager/system/ping') {
          return new Response('', { status: 200, headers: { 'X-Homey-ID': HOMEY_ID } });
        }
        return version('192.168.1.50:80');
      });

      expect(path).toBe(`v3.20.0/#homey=${HOMEY_ID} local`);
      expect(hosts).toEqual([LOCAL, LOCAL]);
    });

    it('stays on the cloud when another Homey answers on the home-network address', async () => {
      listHouse(LOCAL);
      const path = await openWith('', (pathname) => (pathname === '/api/manager/system/ping'
        ? new Response('', { status: 200, headers: { 'X-Homey-ID': '6acdea6cd18dc40482d6bc10' } })
        : version(null)));

      expect(path).toBe(`v3.20.0/#homey=${HOMEY_ID} cloud`);
    });
  });

  describe('adding Homeys to a phone', () => {
    const CABIN_ID = '6acdea6cd18dc40482d6bc10';
    const listed = (homeys: object[]) => window.localStorage.setItem(
      'pels.webapp.homeys.v1',
      JSON.stringify({ homeys, lastHomeyId: null }),
    );
    const house = { name: 'House', baseUrl: `https://${HOMEY_ID}.connect.athom.com`, homeyId: HOMEY_ID, token: 'u:s:t' };
    const versionAnswer = () => response(200, '{"version":"3.20.0","timeZone":"Europe/Oslo"}');

    it('shows a code on the computer, and takes it away when done', async () => {
      listed([house]);
      await loadLauncher(versionAnswer, () => expect(document.getElementById('webapp-pair-phone')?.hidden).toBe(false));

      document.getElementById('webapp-pair-phone')?.click();
      expect(document.getElementById('webapp-pair-panel')?.hidden).toBe(false);
      expect(document.querySelectorAll('#webapp-pair-codes svg')).toHaveLength(1);

      document.getElementById('webapp-pair-done')?.click();
      expect(document.getElementById('webapp-pair-codes')?.children).toHaveLength(0);
    });

    it('takes the code away when a Homey is removed', async () => {
      listed([house, { ...house, name: 'Cabin', homeyId: CABIN_ID, baseUrl: `https://${CABIN_ID}.connect.athom.com` }]);
      await loadLauncher(versionAnswer, () => expect(document.getElementById('webapp-pair-phone')?.hidden).toBe(false));
      document.getElementById('webapp-pair-phone')?.click();

      ([...document.querySelectorAll('md-text-button')].find((element) => element.textContent === 'Remove') as HTMLElement)
        .click();

      await vi.waitFor(() => expect(document.getElementById('webapp-pair-panel')?.hidden).toBe(true));
      expect(document.getElementById('webapp-pair-codes')?.children).toHaveLength(0);
    });

    it('names a Homey whose code cannot fit instead of failing the panel', async () => {
      listed([house, { ...house, name: 'x'.repeat(3000), homeyId: CABIN_ID, baseUrl: `https://${CABIN_ID}.connect.athom.com` }]);
      await loadLauncher(versionAnswer, () => expect(document.getElementById('webapp-pair-phone')?.hidden).toBe(false));

      document.getElementById('webapp-pair-phone')?.click();

      expect(document.querySelectorAll('#webapp-pair-codes figure')).toHaveLength(1);
      expect(document.getElementById('webapp-pair-codes')?.textContent).toContain('the name is too long for a code');
    });

    it('shows a code per Homey when they do not fit in one', async () => {
      const many = Array.from({ length: 12 }, (_unused, index) => ({
        name: `Homey ${index}`,
        homeyId: index.toString(16).padStart(24, 'a'),
        token: `${'1'.repeat(36)}:${'2'.repeat(36)}:${index.toString().padStart(40, '3')}`,
        baseUrl: `https://${index.toString(16).padStart(24, 'a')}.homey.athom-prod-euwest1-001.homeypro.net`,
      }));
      listed(many);
      await loadLauncher(versionAnswer, () => expect(document.getElementById('webapp-pair-phone')?.hidden).toBe(false));

      document.getElementById('webapp-pair-phone')?.click();

      const codes = [...document.querySelectorAll('#webapp-pair-codes figure')];
      expect(codes).toHaveLength(12);
      expect(codes[3]?.textContent).toBe('Homey 3');
    });

    it('takes the code out of the address bar and adds its Homeys only when asked', async () => {
      listed([{ ...house, localUrl: 'https://192-168-1-50.homey.homeylocal.com' }]);
      const { pairingLink } = await import('../src/remote/phonePairing.ts');
      const link = pairingLink('http://localhost:3000/', [
        { name: 'Home', homeyId: HOMEY_ID, token: 'u:new:key', baseUrl: `https://${HOMEY_ID}.connect.athom.com`, localUrl: null },
        { name: 'Cabin', homeyId: CABIN_ID, token: 'u:s:t', baseUrl: `https://${CABIN_ID}.connect.athom.com`, localUrl: null },
      ]);
      window.history.replaceState(null, '', `/${new URL(link).hash}`);
      try {
        await loadLauncher(versionAnswer, () => expect(document.getElementById('webapp-import-panel')?.hidden).toBe(false));

        expect(window.location.hash).toBe('');
        expect(document.getElementById('webapp-import-text')?.textContent).toContain('Home, Cabin');
        expect(storedNames()).toEqual(['House']);

        document.getElementById('webapp-import-add')?.click();

        await vi.waitFor(() => expect(document.getElementById('webapp-import-panel')?.hidden).toBe(true));
        const stored = JSON.parse(window.localStorage.getItem('pels.webapp.homeys.v1') ?? '{}') as {
          homeys: { name: string; token: string; localUrl: string | null }[];
        };
        expect(stored.homeys.map(({ name, token, localUrl }) => [name, token, localUrl])).toEqual([
          ['Home', 'u:new:key', 'https://192-168-1-50.homey.homeylocal.com'],
          ['Cabin', 'u:s:t', null],
        ]);
      } finally {
        window.history.replaceState(null, '', '/');
      }
    });

    const scan = async (homeys: object[], search = '') => {
      const { pairingLink } = await import('../src/remote/phonePairing.ts');
      const link = pairingLink('http://localhost:3000/', homeys as never);
      window.history.replaceState(null, '', `/${search}${new URL(link).hash}`);
    };
    const stored = () => (JSON.parse(window.localStorage.getItem('pels.webapp.homeys.v1') ?? '{"homeys":[]}') as {
      homeys: { name: string; token: string; baseUrl: string }[];
    }).homeys;

    it('keeps a saved key that Homey does not accept in place of the one in the code', async () => {
      const cloud = `https://${HOMEY_ID}.homey.athom-prod-euwest1-001.homeypro.net`;
      listed([{ ...house, baseUrl: cloud }]);
      await scan([{ name: 'Home', homeyId: HOMEY_ID, token: 'a:b:c', baseUrl: `https://${HOMEY_ID}.connect.athom.com` }]);
      try {
        await loadLauncher(
          (pathname) => (pathname === KEY_CHECK_PATH ? response(401, '{"error":"Invalid Session"}') : versionAnswer()),
          () => expect(document.getElementById('webapp-import-panel')?.hidden).toBe(false),
        );
        expect(document.getElementById('webapp-import-text')?.textContent).toContain('key saved here for Home');

        document.getElementById('webapp-import-add')?.click();

        await vi.waitFor(() => expect(document.getElementById('webapp-import-text')?.textContent)
          .toContain('Kept the key saved here for Home'));
        expect(stored()).toEqual([{ ...house, baseUrl: cloud, localUrl: null }]);
      } finally {
        window.history.replaceState(null, '', '/');
      }
    });

    it('replaces a saved key Homey accepts, and keeps the cloud host learned here', async () => {
      const cloud = `https://${HOMEY_ID}.homey.athom-prod-euwest1-001.homeypro.net`;
      listed([{ ...house, baseUrl: cloud }]);
      await scan([{ name: 'Home', homeyId: HOMEY_ID, token: 'u:new:key', baseUrl: `https://${HOMEY_ID}.connect.athom.com` }]);
      try {
        await loadLauncher(versionAnswer, () => expect(document.getElementById('webapp-import-panel')?.hidden).toBe(false));

        document.getElementById('webapp-import-add')?.click();

        await vi.waitFor(() => expect(stored()[0]?.token).toBe('u:new:key'));
        expect(stored()[0]?.baseUrl).toBe(cloud);
      } finally {
        window.history.replaceState(null, '', '/');
      }
    });

    it('adds none of a code\'s Homeys when the browser refuses to store them', async () => {
      await scan([
        { name: 'Home', homeyId: HOMEY_ID, token: 'u:s:t', baseUrl: `https://${HOMEY_ID}.connect.athom.com` },
        { name: 'Cabin', homeyId: CABIN_ID, token: 'u:s:t', baseUrl: `https://${CABIN_ID}.connect.athom.com` },
      ]);
      try {
        await loadLauncher(versionAnswer, () => expect(document.getElementById('webapp-import-panel')?.hidden).toBe(false));
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
          throw new Error('QuotaExceededError');
        });

        document.getElementById('webapp-import-add')?.click();

        await vi.waitFor(() => expect(document.getElementById('webapp-import-text')?.textContent)
          .toContain('did not save'));
        vi.restoreAllMocks();
        expect(stored()).toEqual([]);
      } finally {
        window.history.replaceState(null, '', '/');
      }
    });

    it('asks before adding, and opens nothing, even when a link names a Homey', async () => {
      listed([house]);
      const assign = vi.fn();
      await scan([{ name: 'Cabin', homeyId: CABIN_ID, token: 'u:s:t', baseUrl: `https://${CABIN_ID}.connect.athom.com` }], `?open=${HOMEY_ID}`);
      vi.stubGlobal('location', { ...window.location, assign });
      try {
        await loadLauncher(versionAnswer, () => expect(document.getElementById('webapp-import-panel')?.hidden).toBe(false));
        await vi.waitFor(() => expect(document.getElementById('webapp-homey-list')?.textContent).toContain('PELS 3.20.0'));

        expect(assign).not.toHaveBeenCalled();
        expect(stored().map((homey) => homey.name)).toEqual(['House']);
      } finally {
        vi.unstubAllGlobals();
        window.history.replaceState(null, '', '/');
      }
    });

    it('says when a code could not be read, and adds nothing', async () => {
      window.history.replaceState(null, '', '/#pair=not-a-code');
      try {
        await loadLauncher(versionAnswer, () => expect(document.getElementById('webapp-import-panel')?.hidden).toBe(false));

        expect(document.getElementById('webapp-import-text')?.textContent).toContain('could not be read');
        expect(document.getElementById('webapp-import-add')?.hidden).toBe(true);
        expect(window.location.hash).toBe('');
      } finally {
        window.history.replaceState(null, '', '/');
      }
    });
  });

  it('points the key hint at the API Keys page of the Homey a link names', async () => {
    window.history.replaceState(null, '', `/?open=${HOMEY_ID}`);
    try {
      await loadLauncher(() => response(200, 'null'));
      expect(document.getElementById('webapp-api-keys-link')?.getAttribute('href'))
        .toBe(`https://my.homey.app/homeys/${HOMEY_ID}/settings/system/api-keys`);
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('shows the add form for a named Homey that is not listed, not the last one', async () => {
    window.localStorage.setItem('pels.webapp.homeys.v1', JSON.stringify({
      homeys: [{ name: 'House', baseUrl: `https://${HOMEY_ID}.connect.athom.com`, homeyId: HOMEY_ID, token: 'u:s:t' }],
      lastHomeyId: HOMEY_ID,
    }));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, search: '?open=6acdea6cd18dc40482d6bc10', assign });
    try {
      await loadLauncher(
        () => response(200, '{"version":"3.20.0","timeZone":"Europe/Oslo","homeyId":"x"}'),
        () => expect(document.getElementById('webapp-homey-list')?.textContent).toContain('PELS 3.20.0'),
      );
      expect(assign).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
