import { afterEach, expect, it, vi } from 'vitest';
import { installHomeyMock } from './helpers/homeyApiMock.ts';
import { setHomeyClient } from '../src/ui/homey.ts';
import {
  readHomeMembership,
  refreshHomeScope,
  subscribeToHomeScope,
} from '../src/ui/homeScope.ts';
import { initCurrentModes } from '../src/ui/currentModes.ts';
import { SETTINGS_UI_HOMES_PATH } from '../../contracts/src/settingsUiHomes.ts';

vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  setHomeyClient(null);
});

it('notifies setup consumers when the roster first resolves', async () => {
  const homey = installHomeyMock();
  setHomeyClient(homey as never);
  const membershipStates: string[] = [];
  subscribeToHomeScope(() => { membershipStates.push(readHomeMembership().state); });
  initCurrentModes();

  expect(readHomeMembership()).toEqual({ state: 'loading' });
  await refreshHomeScope();

  expect(membershipStates).toEqual(['resolved']);
  expect(homey.api.mock.calls.filter(([, path]) => path === SETTINGS_UI_HOMES_PATH)).toHaveLength(1);
});
