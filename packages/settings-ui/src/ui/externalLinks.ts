import { getHomeyClient } from './homey.ts';

// Homey's web app shows this page in a sandbox without `allow-popups`, so a
// normal click on a link that opens a new tab does nothing (the context menu's
// "open in new window" still works). Homey opens such links itself through
// `Homey.openURL`; a host without it, such as the standalone web app, opens
// them as any browser does.
export const initExternalLinks = (): void => {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;
    const href = event.target.closest('[target="_blank"][href]')?.getAttribute('href');
    const client = getHomeyClient();
    if (!href || !client?.openURL) return;
    event.preventDefault();
    // A method call: Homey's `openURL` reads its own `this`.
    client.openURL(new URL(href, window.location.href).href);
  });
};
