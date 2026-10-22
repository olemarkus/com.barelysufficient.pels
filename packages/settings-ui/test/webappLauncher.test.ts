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

const loadLauncher = async (homey: (pathname: string) => Response, ready: () => void = () => {
  expect(document.getElementById('webapp-add-panel')?.hidden).toBe(false);
}) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'webapp-launcher.html'), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script').forEach((script) => script.remove());
  document.body.innerHTML = parsed.body.innerHTML;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === 'versions.json') return response(200, publishedVersions);
    return homey(new URL(input).pathname);
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
});
