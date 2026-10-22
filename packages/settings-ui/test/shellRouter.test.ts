import {
  buildDom,
  installSettingsHomeyMock,
  loadSettingsScript,
  releasePageResourcesAfterEachTest,
  waitFor,
} from './helpers/settingsPage.ts';
import { panelFromSearch, shellRouteUrl } from '../src/ui/shellRoutes.ts';

vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
}));

releasePageResourcesAfterEachTest();

const shown = (panelId: string) => (
  document.querySelector(`[data-panel="${panelId}"]`)?.classList.contains('hidden') === false
);
const settingsTabLit = () => (
  document.querySelector('[data-tab="settings"]')?.getAttribute('aria-selected') === 'true'
);

describe('shell routes', () => {
  it.each([
    ['?page=budget', 'budget'],
    ['?page=settings/limits', 'limits'],
    ['?page=settings/web-app', 'web-app'],
    ['?page=settings', 'settings'],
    ['', null],
    ['?page=limits', null],
    ['?page=settings/nope', null],
    ['?page=deadline-plan&deviceId=a', null],
  ])('reads %j as %s', (search, panelId) => {
    expect(panelFromSearch(search)).toBe(panelId);
  });

  it('keeps the path, fragment and unrelated parameters, and drops a Smart task route\'s', () => {
    const location = { pathname: '/app/v3.21.0/', search: '?page=deadline-plan&deviceId=a&edit=1&x=1', hash: '#homey=abc' };
    expect(shellRouteUrl('limits', location)).toBe('/app/v3.21.0/?page=settings%2Flimits&x=1#homey=abc');
  });
});

describe('shell router', () => {
  beforeEach(() => {
    vi.resetModules();
    window.history.replaceState(null, '', '/');
    buildDom();
    window.localStorage.clear();
    installSettingsHomeyMock();
  });

  it('opens the page the URL names', async () => {
    window.history.replaceState(null, '', '/?page=settings/limits');
    const { boot } = await import('../src/ui/boot.ts');
    await boot();
    await waitFor(() => shown('limits'));
    expect(settingsTabLit()).toBe(true);
  });

  it('gives a tab its own URL and returns to the previous page on Back', async () => {
    // The harness opens Settings → Devices after boot.
    await loadSettingsScript();
    const { showTab } = await import('../src/ui/realtime.ts');

    showTab('budget');
    expect(window.location.search).toBe('?page=budget');
    expect(shown('budget')).toBe(true);

    window.history.back();
    await waitFor(() => shown('devices'));
    expect(settingsTabLit()).toBe(true);
    window.history.forward();
    await waitFor(() => shown('budget'));
  });

  it('steps back with an app-bar arrow instead of adding an entry', async () => {
    document.getElementById('limits-panel')?.insertAdjacentHTML(
      'afterbegin',
      '<button type="button" class="pels-appbar__back" data-settings-target="settings"></button>',
    );
    await loadSettingsScript();
    const { showTab } = await import('../src/ui/realtime.ts');
    showTab('settings');
    (document.querySelector('[data-settings-target="limits"]') as HTMLElement).click();
    expect(window.location.search).toBe(`?page=${encodeURIComponent('settings/limits')}`);
    const entries = window.history.length;

    (document.querySelector('#limits-panel .pels-appbar__back') as HTMLElement).click();

    await waitFor(() => shown('settings'));
    expect(window.location.search).toBe('?page=settings');
    expect(window.history.length).toBe(entries);
  });

  it('lights the Settings tab on every Settings sub-page', async () => {
    await loadSettingsScript();
    const { showTab } = await import('../src/ui/realtime.ts');
    showTab('homes');
    expect(settingsTabLit()).toBe(true);
  });

  it('gives the Daily budget editor its own URL, and Forward reopens it after Done', async () => {
    await loadSettingsScript();
    const { showTab } = await import('../src/ui/realtime.ts');
    showTab('settings');

    (document.querySelector('[data-settings-target="budget-adjust"]') as HTMLElement).click();
    expect(new URLSearchParams(window.location.search).get('page')).toBe('settings/budget-adjust');
    await waitFor(() => document.querySelector('#budget-redesign-adjust-view') !== null);
    expect(settingsTabLit()).toBe(true);

    (document.querySelector('.pels-appbar__back') as HTMLElement).click();
    await waitFor(() => shown('settings'));

    window.history.forward();
    await waitFor(() => shown('budget') && document.querySelector('#budget-redesign-adjust-view') !== null);
    expect(settingsTabLit()).toBe(true);
  });
});
