import {
  SETTINGS_UI_VERSION_PATH,
  type SettingsUiVersionRead,
} from '../../../contracts/src/settingsUiApi.ts';
import { callApi } from './homey.ts';
import { logSettingsWarn } from './logging.ts';

// The "Open in a browser" sub-page shows this Homey's address to copy into the
// web app, and links to the web app so it opens this Homey once it is added.
// The web app never takes an address from a link: where an API key is sent
// must come from the owner, here from their own Homey's settings page.
export const WEB_APP_URL = 'https://pels.barelysufficient.org/app/';

export const buildWebAppHref = (homeyId: string): string => (
  `${WEB_APP_URL}?open=${encodeURIComponent(homeyId)}`
);

type TextField = HTMLElement & { value: string };

// Without the id the link still opens the web app, and the owner copies the
// address from the Homey web app instead.
export const refreshWebAppLink = async (): Promise<void> => {
  const link = document.getElementById('web-app-open-link');
  const address = document.getElementById('web-app-homey-address') as TextField | null;
  if (!link || !address) return;
  try {
    const read = await callApi<Partial<SettingsUiVersionRead> | null>('GET', SETTINGS_UI_VERSION_PATH);
    const homeyId = read?.homeyId;
    if (typeof homeyId !== 'string' || homeyId === '') throw new Error('The version answer carries no Homey id');
    link.setAttribute('href', buildWebAppHref(homeyId));
    address.value = homeyId;
    address.closest<HTMLElement>('.field')?.removeAttribute('hidden');
  } catch (error) {
    link.setAttribute('href', WEB_APP_URL);
    address.closest<HTMLElement>('.field')?.setAttribute('hidden', '');
    await logSettingsWarn('Could not read the Homey id for the web app link', error, 'webAppLink');
  }
};
