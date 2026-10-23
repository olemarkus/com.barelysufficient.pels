import {
  SETTINGS_UI_VERSION_PATH,
  type SettingsUiVersionRead,
} from '../../../contracts/src/settingsUiApi.ts';
import { WEB_APP_CLOUD_HOST } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { readWebAppCloudHost, webAppCloudHostFromOrigin } from '../../../shared-domain/src/settings/webAppCloudHost.ts';
import { cloudAddressFor } from '../remote/homeyAddress.ts';
import { callApi, getSetting, setSetting } from './homey.ts';
import { logSettingsWarn } from './logging.ts';

// The "Open in a browser" sub-page shows this Homey's address to copy into the
// web app, and links to the web app so it opens this Homey once it is added.
// The web app never adds a Homey from a link: where an API key is sent must
// come from the owner, here from their own Homey's settings page.
export const WEB_APP_URL = 'https://pels.barelysufficient.org/app/';

// Homey's web app serves this page from the Homey's own cloud host when it
// reaches the Homey through the cloud, and from the home-network address when
// it can reach it directly. The cloud host takes far more calls than the relay
// a bare id leads to, so the link carries it (`via`) for a Homey the web app
// already lists, and the address to copy is that host whenever this page or
// PELS knows it.
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
    const learned = readWebAppCloudHost(read?.cloudHost, homeyId);
    const cloudUrl = cloudAddressFor(window.location.origin, homeyId) ?? learned;
    link.setAttribute('href', buildWebAppHref(homeyId, cloudUrl));
    address.value = cloudUrl ?? homeyId;
    address.closest<HTMLElement>('.field')?.removeAttribute('hidden');
  } catch (error) {
    link.setAttribute('href', WEB_APP_URL);
    address.closest<HTMLElement>('.field')?.setAttribute('hidden', '');
    await logSettingsWarn('Could not read the Homey id for the web app link', error, 'webAppLink');
  }
};

// The web app cannot learn this Homey's cloud host any other way
// (`shared-domain/src/settings/webAppCloudHost.ts`), so every boot from that
// host saves it when it changed. The bootstrap carries the stored value, so an
// unchanged host costs no call; a page served from the home network or in the
// web app has nothing to save.
export const saveCloudHost = async (): Promise<void> => {
  const cloudHost = webAppCloudHostFromOrigin(window.location.origin);
  if (cloudHost === null) return;
  try {
    if (await getSetting(WEB_APP_CLOUD_HOST) === cloudHost) return;
    await setSetting(WEB_APP_CLOUD_HOST, cloudHost);
  } catch (error) {
    await logSettingsWarn('Could not save the cloud address for the web app', error, 'webAppLink');
  }
};
