import { afterEach, expect, it, vi } from 'vitest';
import { installHomeyMock } from './helpers/homeyApiMock.ts';

vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.resetModules();
});

it('publishes an unavailable membership after the bounded initial roster read fails', async () => {
  document.body.innerHTML = '<div id="current-modes-root"></div>';
  const homey = installHomeyMock();
  homey.api.mockImplementationOnce((_method, _path, callback) => {
    callback(new Error('roster unavailable'));
  });
  const { setHomeyClient } = await import('../src/ui/homey.ts');
  const {
    readHomeMembership,
    refreshHomeScope,
    subscribeToHomeScope,
  } = await import('../src/ui/homeScope.ts');
  const { initCurrentModes } = await import('../src/ui/currentModes.ts');
  setHomeyClient(homey as never);
  const states: string[] = [];
  subscribeToHomeScope(() => { states.push(readHomeMembership().state); });
  initCurrentModes();

  await refreshHomeScope();

  expect(readHomeMembership()).toEqual({ state: 'unavailable' });
  expect(states).toEqual(['unavailable']);
  expect(document.querySelector('#current-modes-root')?.textContent)
    .toContain('Modes couldn’t be loaded.');
  setHomeyClient(null);
  document.body.innerHTML = '';
});
