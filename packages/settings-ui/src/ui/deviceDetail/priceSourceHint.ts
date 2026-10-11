import { deviceDetailPriceOptRow } from '../dom.ts';
import { getPricesReadModel } from '../prices.ts';
import { resolvePriceSetupStatus, type PriceSetupStatus } from '../priceSetupStatus.ts';

/**
 * The line under a device's Price-based control that says where its prices
 * come from, and whether they are set up. Turning price control on must never
 * hide an unset price source: an owner whose prices leave out the grid tariff
 * sees it here, with the way to fix it.
 */

// Queried here rather than in `dom.ts`, like the start-policy hints: these two
// elements have exactly one consumer.
const q = <T extends Element>(id: string): T | null => document.querySelector<T>(id);
const hintEl = q<HTMLElement>('#device-detail-price-source-hint');
const actionEl = q<HTMLElement>('#device-detail-price-source-action');

let syncGeneration = 0;

const render = (shown: boolean, status: PriceSetupStatus): void => {
  if (!hintEl || !actionEl) return;
  const visible = shown && status.state !== 'unavailable';
  hintEl.hidden = !visible;
  actionEl.hidden = !visible || status.state !== 'open';
  if (!visible) return;
  const open = status.state === 'open';
  hintEl.classList.toggle('field__hint--alert', open);
  hintEl.textContent = open ? `Price setup isn’t finished. ${status.summary}` : `Prices from ${status.summary}.`;
};

/** Show the Price-based control row, with its source line, only where `shown`. */
export const syncPriceOptRow = async (shown: boolean): Promise<void> => {
  if (deviceDetailPriceOptRow) deviceDetailPriceOptRow.hidden = !shown;
  syncGeneration += 1;
  const generation = syncGeneration;
  if (!shown) {
    render(false, { state: 'unavailable' });
    return;
  }
  let status: PriceSetupStatus;
  try {
    status = resolvePriceSetupStatus(await getPricesReadModel());
  } catch {
    // The line claims nothing it could not read; the next sync tries again.
    status = { state: 'unavailable' };
  }
  // A later sync (another device, or a newer read) owns the line now.
  if (generation === syncGeneration) render(true, status);
};
