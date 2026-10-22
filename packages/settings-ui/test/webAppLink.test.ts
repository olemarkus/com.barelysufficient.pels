const callApi = vi.fn();
const logSettingsWarn = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args),
}));
vi.mock('../src/ui/logging.ts', () => ({
  logSettingsWarn: (...args: unknown[]) => logSettingsWarn(...args),
}));

const { WEB_APP_URL, refreshWebAppLink } = await import('../src/ui/webAppLink.ts');

const link = () => document.getElementById('web-app-open-link');

describe('Open in a browser link', () => {
  beforeEach(() => {
    document.body.innerHTML = [
      '<div class="field" hidden><md-filled-text-field id="web-app-homey-address" readonly></md-filled-text-field></div>',
      `<md-filled-button id="web-app-open-link" href="${WEB_APP_URL}"></md-filled-button>`,
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
