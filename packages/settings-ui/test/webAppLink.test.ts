const callApi = vi.fn();
const getSetting = vi.fn();
const setSetting = vi.fn();
const logSettingsWarn = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args),
  getSetting: (...args: unknown[]) => getSetting(...args),
  setSetting: (...args: unknown[]) => setSetting(...args),
}));
vi.mock('../src/ui/logging.ts', () => ({
  logSettingsWarn: (...args: unknown[]) => logSettingsWarn(...args),
}));

const { WEB_APP_URL, initWebAppAddressCopy, refreshWebAppLink, saveCloudHost } = await import('../src/ui/webAppLink.ts');

const link = () => document.getElementById('web-app-open-link');

describe('Open in a browser link', () => {
  beforeEach(() => {
    document.body.innerHTML = [
      '<div class="field" hidden><md-filled-text-field id="web-app-homey-address" readonly></md-filled-text-field></div>',
      `<md-filled-button id="web-app-open-link" href="${WEB_APP_URL}"></md-filled-button>`,
      '<md-text-button id="web-app-copy-address">Copy address</md-text-button>',
    ].join('');
    callApi.mockReset();
  });

  it('shows this Homey\'s address and links to the web app to open it', async () => {
    callApi.mockResolvedValue({ version: '3.21.0', timeZone: 'Europe/Oslo', homeyId: '65687b03c6bcab0c0a4464c3' });

    await refreshWebAppLink();

    expect(callApi).toHaveBeenCalledWith('GET', '/ui_version');
    expect(link()?.getAttribute('href')).toBe(`${WEB_APP_URL}?open=65687b03c6bcab0c0a4464c3`);
    const address = document.getElementById('web-app-homey-address') as HTMLElement & { value: string };
    expect(address.value).toBe('65687b03c6bcab0c0a4464c3');
    expect(address.closest('.field')?.hasAttribute('hidden')).toBe(false);
  });

  it('shows and links this Homey\'s cloud host when Homey serves the page from it', async () => {
    const cloud = 'https://65687b03c6bcab0c0a4464c3.homey.athom-prod-euwest1-001.homeypro.net';
    vi.stubGlobal('location', { ...window.location, origin: cloud });
    try {
      callApi.mockResolvedValue({ version: '3.21.0', timeZone: 'Europe/Oslo', homeyId: '65687b03c6bcab0c0a4464c3' });

      await refreshWebAppLink();

      expect(link()?.getAttribute('href'))
        .toBe(`${WEB_APP_URL}?open=65687b03c6bcab0c0a4464c3&via=${encodeURIComponent(cloud)}`);
      expect((document.getElementById('web-app-homey-address') as HTMLElement & { value: string }).value).toBe(cloud);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Served from the home network, the page shows the cloud host PELS learned.
  it('shows and links the cloud host PELS learned when the page comes from the home network', async () => {
    const cloud = 'https://65687b03c6bcab0c0a4464c3.homey.athom-prod-euwest1-001.homeypro.net';
    vi.stubGlobal('location', { ...window.location, origin: 'https://192-168-89-241.homey.homeylocal.com' });
    try {
      callApi.mockResolvedValue({
        version: '3.21.1', timeZone: 'Europe/Oslo', homeyId: '65687b03c6bcab0c0a4464c3', cloudHost: cloud,
      });

      await refreshWebAppLink();

      expect(link()?.getAttribute('href'))
        .toBe(`${WEB_APP_URL}?open=65687b03c6bcab0c0a4464c3&via=${encodeURIComponent(cloud)}`);
      expect((document.getElementById('web-app-homey-address') as HTMLElement & { value: string }).value).toBe(cloud);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('saves the page\'s origin only when Homey serves it from a cloud host it does not hold yet', async () => {
    const cloud = 'https://65687b03c6bcab0c0a4464c3.homey.athom-prod-euwest1-001.homeypro.net';
    const servedFrom = (origin: string) => vi.stubGlobal('location', { ...window.location, origin });
    getSetting.mockReset().mockResolvedValue(undefined);
    setSetting.mockReset().mockResolvedValue(undefined);
    try {
      servedFrom(cloud);
      await saveCloudHost();
      expect(getSetting).toHaveBeenCalledWith('web_app_cloud_host');
      expect(setSetting).toHaveBeenCalledWith('web_app_cloud_host', cloud);

      // Already saved: the bootstrap-primed read answers, and nothing is written.
      setSetting.mockClear();
      getSetting.mockResolvedValue(cloud);
      await saveCloudHost();

      servedFrom('https://192-168-89-241.homey.homeylocal.com');
      await saveCloudHost();
      servedFrom('https://pels.barelysufficient.org');
      await saveCloudHost();
      expect(setSetting).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('copies the address, and selects it where the clipboard is refused', async () => {
    const address = document.getElementById('web-app-homey-address') as HTMLElement & { value: string; select: () => void };
    address.value = 'https://65687b03c6bcab0c0a4464c3.homey.athom-prod-euwest1-001.homeypro.net';
    address.select = vi.fn();
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      initWebAppAddressCopy();
      const copy = document.getElementById('web-app-copy-address') as HTMLElement;

      copy.click();
      await vi.waitFor(() => expect(copy.textContent).toBe('Copied'));
      expect(writeText).toHaveBeenCalledWith(address.value);

      copy.click();
      await vi.waitFor(() => expect(address.select).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ignores an answer without a Homey id', async () => {
    callApi.mockResolvedValue({ version: '3.20.0', timeZone: 'Europe/Oslo' });

    await refreshWebAppLink();

    expect(link()?.getAttribute('href')).toBe(WEB_APP_URL);
  });

  it('still links to the web app when the Homey id cannot be read', async () => {
    callApi.mockRejectedValue(new Error('PELS_APP_NOT_READY: starting'));

    await refreshWebAppLink();

    expect(link()?.getAttribute('href')).toBe(WEB_APP_URL);
    expect(document.getElementById('web-app-homey-address')?.closest('.field')?.hasAttribute('hidden')).toBe(true);
    expect(logSettingsWarn).toHaveBeenCalled();
  });
});
