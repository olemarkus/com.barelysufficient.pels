import {
  SETTINGS_UI_VERSION_PATH,
  type SettingsUiVersionRead,
} from '../../../contracts/src/settingsUiApi.ts';
import { cloudAddressFor } from '../remote/homeyAddress.ts';
import { callApi } from './homey.ts';
import { logSettingsWarn } from './logging.ts';

// The "Open in a browser" sub-page shows this Homey's address to copy into the
// web app, and links to the web app so it opens this Homey once it is added.
// The web app never adds a Homey from a link: where an API key is sent must
// come from the owner, here from their own Homey's settings page.
export const WEB_APP_URL = 'https://pels.barelysufficient.org/app/';

// Homey's web app serves this page from the Homey's own cloud host, which
// takes far more calls than the relay a bare id leads to. The link carries it
// (`via`) for a Homey the web app already lists, and the address to copy is
// that host whenever this page knows it.
export const buildWebAppHref = (homeyId: string, cloudUrl: string | null): string => {
  const params = new URLSearchParams({ open: homeyId });
  if (cloudUrl) params.set('via', cloudUrl);
  return `${WEB_APP_URL}?${params.toString()}`;
};

type TextField = HTMLElement & { value: string; select: () => void };

// Copies the address; where the WebView refuses the clipboard, the address is
// selected for the owner's own copy.
export const initWebAppAddressCopy = (): void => {
  const copy = document.getElementById('web-app-copy-address');
  const address = document.getElementById('web-app-homey-address') as TextField | null;
  if (!copy || !address) return;
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(address.value).then(
      () => {
        copy.textContent = 'Copied';
      },
      () => address.select(),
    );
  });
};

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
    const cloudUrl = cloudAddressFor(window.location.origin, homeyId);
    link.setAttribute('href', buildWebAppHref(homeyId, cloudUrl));
    address.value = cloudUrl ?? homeyId;
    address.closest<HTMLElement>('.field')?.removeAttribute('hidden');
  } catch (error) {
    link.setAttribute('href', WEB_APP_URL);
    address.closest<HTMLElement>('.field')?.setAttribute('hidden', '');
    await logSettingsWarn('Could not read the Homey id for the web app link', error, 'webAppLink');
  }
};
