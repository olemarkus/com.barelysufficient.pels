import { renderSVG } from 'uqr';
import { pairingLink } from './phonePairing.ts';
import type { StoredHomey } from './remoteConnection.ts';

// The QR codes the launcher shows for a phone, drawn in the page so the keys
// they hold never leave it.

const drawCode = (link: string, caption: string | null): HTMLElement => {
  const svg = renderSVG(link, { ecc: 'M', border: 2, whiteColor: '#ffffff', blackColor: '#000000' });
  const code = document.createElement('figure');
  code.className = 'webapp-pair-code';
  code.setAttribute('role', 'img');
  code.setAttribute('aria-label', `Code ${caption ? `for ${caption} ` : ''}to scan with your phone`);
  code.append(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement);
  if (caption) {
    const label = document.createElement('figcaption');
    label.textContent = caption;
    code.append(label);
  }
  return code;
};

// A Homey whose code does not fit, which only a name stored before names had
// a bound can cause, is named instead of failing the whole panel.
const drawHomeyCode = (launcher: string, homey: StoredHomey): HTMLElement => {
  try {
    return drawCode(pairingLink(launcher, [homey]), homey.name);
  } catch {
    const note = document.createElement('p');
    note.className = 'field__hint';
    note.textContent = `${homey.name}: the name is too long for a code. `
      + 'Remove this Homey and add it with a shorter name.';
    return note;
  }
};

// One code for every Homey when they fit in one; past that (around eight
// Homeys), a code each.
export const drawPairingCodes = (launcher: string, homeys: readonly StoredHomey[]): HTMLElement[] => {
  try {
    return [drawCode(pairingLink(launcher, homeys), null)];
  } catch {
    return homeys.map((homey) => drawHomeyCode(launcher, homey));
  }
};
