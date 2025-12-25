import { priceList, priceEmpty, priceStatusBadge } from './dom';
import { getTimeAgo } from './utils';
import type { CombinedPriceData, PriceEntry } from './priceTypes';
import { createDeviceRow } from './components';

const setPriceStatusBadge = (text: string, statusClass?: 'ok' | 'warn') => {
  if (!priceStatusBadge) return;
  priceStatusBadge.textContent = text;
  priceStatusBadge.classList.remove('ok', 'warn');
  if (statusClass) {
    priceStatusBadge.classList.add(statusClass);
  }
};

const getCurrentHour = (now: Date) => {
  const currentHour = new Date(now);
  currentHour.setMinutes(0, 0, 0);
  return currentHour;
};

const getFuturePrices = (prices: PriceEntry[], currentHour: Date) => (
  prices.filter((price) => new Date(price.startsAt) >= currentHour)
);

const findCurrentEntry = (prices: PriceEntry[], currentHour: Date) => (
  prices.find((price) => new Date(price.startsAt).getTime() === currentHour.getTime())
);

const getPriceIndicatorIcon = (tone: 'cheap' | 'expensive' | 'neutral') => {
  if (tone === 'cheap') return '🟢';
  if (tone === 'expensive') return '🔴';
  return '⚪';
};

const buildPriceSummaryItem = (
  tone: 'cheap' | 'expensive' | 'neutral',
  count: number | null,
  label: string,
  detailText: string,
) => {
  const item = document.createElement('div');
  item.className = 'price-summary-item';

  const indicator = document.createElement('span');
  indicator.className = `price-indicator ${tone}`;
  indicator.textContent = getPriceIndicatorIcon(tone);
  item.appendChild(indicator);

  const text = document.createElement('span');
  if (count !== null) {
    const strong = document.createElement('strong');
    strong.textContent = count.toString();
    const suffix = count === 1 ? '' : 's';
    text.append(strong, ` ${label}${suffix}${detailText ? ` ${detailText}` : ''}`);
  } else {
    text.textContent = detailText;
  }
  item.appendChild(text);

  return item;
};

const buildPriceSummarySection = (
  cheapHours: PriceEntry[],
  expensiveHours: PriceEntry[],
  thresholdPct: number,
) => {
  const summarySection = document.createElement('div');
  summarySection.className = 'price-summary';

  if (cheapHours.length > 0) {
    const cheapest = cheapHours[0];
    const cheapestTime = new Date(cheapest.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const detailText = `(cheapest: ${cheapest.total.toFixed(0)} øre at ${cheapestTime})`;
    summarySection.appendChild(buildPriceSummaryItem('cheap', cheapHours.length, 'cheap hour', detailText));
  } else {
    summarySection.appendChild(
      buildPriceSummaryItem('neutral', null, '', `No cheap hours (<${thresholdPct}% below avg)`),
    );
  }

  if (expensiveHours.length > 0) {
    const mostExpensive = expensiveHours[0];
    const expensiveTime = new Date(mostExpensive.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const detailText = `(peak: ${mostExpensive.total.toFixed(0)} øre at ${expensiveTime})`;
    summarySection.appendChild(buildPriceSummaryItem('expensive', expensiveHours.length, 'expensive hour', detailText));
  } else {
    summarySection.appendChild(
      buildPriceSummaryItem('neutral', null, '', `No expensive hours (>${thresholdPct}% above avg)`),
    );
  }

  return summarySection;
};

const buildPriceDetailsSection = (
  title: string,
  entries: PriceEntry[],
  currentHour: Date,
  now: Date,
  priceClass: string,
) => {
  const details = document.createElement('details');
  details.className = 'price-details';
  const summary = document.createElement('summary');
  summary.textContent = title;
  details.appendChild(summary);
  entries.forEach((entry) => {
    details.appendChild(createPriceRow(entry, currentHour, now, priceClass));
  });
  return details;
};

const getPriceClass = (entry: PriceEntry) => {
  if (entry.isCheap) return 'price-low';
  if (entry.isExpensive) return 'price-high';
  return 'price-normal';
};

const buildPriceNotice = (className: string, text: string) => {
  const notice = document.createElement('div');
  notice.className = className;
  notice.textContent = text;
  return notice;
};

type PriceRenderContext = {
  now: Date;
  currentHour: Date;
  futurePrices: PriceEntry[];
  currentEntry?: PriceEntry;
  cheapHours: PriceEntry[];
  expensiveHours: PriceEntry[];
  thresholdPct: number;
  avgPrice: number;
};

const buildPriceRenderContext = (data: CombinedPriceData): PriceRenderContext | null => {
  const now = new Date();
  const currentHour = getCurrentHour(now);
  const futurePrices = getFuturePrices(data.prices, currentHour);
  if (futurePrices.length === 0) return null;

  const cheapHours = futurePrices.filter((price) => price.isCheap).sort((a, b) => a.total - b.total);
  const expensiveHours = futurePrices.filter((price) => price.isExpensive).sort((a, b) => b.total - a.total);

  return {
    now,
    currentHour,
    futurePrices,
    currentEntry: findCurrentEntry(futurePrices, currentHour),
    cheapHours,
    expensiveHours,
    thresholdPct: data.thresholdPercent ?? 25,
    avgPrice: data.avgPrice,
  };
};

const renderPriceSections = (context: PriceRenderContext) => {
  priceList.appendChild(buildPriceSummarySection(context.cheapHours, context.expensiveHours, context.thresholdPct));

  if (context.cheapHours.length > 0) {
    priceList.appendChild(
      buildPriceDetailsSection(
        `🟢 Cheap hours (${context.cheapHours.length})`,
        context.cheapHours,
        context.currentHour,
        context.now,
        'price-low',
      ),
    );
  }

  if (context.expensiveHours.length > 0) {
    priceList.appendChild(
      buildPriceDetailsSection(
        `🔴 Expensive hours (${context.expensiveHours.length})`,
        context.expensiveHours,
        context.currentHour,
        context.now,
        'price-high',
      ),
    );
  }

  const allEntries = context.futurePrices.map((entry) => ({
    entry,
    priceClass: getPriceClass(entry),
  }));
  const allDetails = document.createElement('details');
  allDetails.className = 'price-details';
  const allSummary = document.createElement('summary');
  allSummary.textContent = `📊 All prices (${context.futurePrices.length} hours, avg ${context.avgPrice.toFixed(0)} øre/kWh)`;
  allDetails.appendChild(allSummary);
  allEntries.forEach(({ entry, priceClass }) => {
    allDetails.appendChild(createPriceRow(entry, context.currentHour, context.now, priceClass));
  });
  priceList.appendChild(allDetails);
};

const renderPriceNotices = (context: PriceRenderContext, data: CombinedPriceData) => {
  const lastPriceTime = new Date(context.futurePrices[context.futurePrices.length - 1].startsAt);
  const hoursRemaining = Math.floor((lastPriceTime.getTime() - context.now.getTime()) / (1000 * 60 * 60)) + 1;
  if (hoursRemaining <= 12) {
    priceList.appendChild(buildPriceNotice(
      'price-notice price-notice-warning',
      `⚠️ Price data available for ${hoursRemaining} more hour${hoursRemaining === 1 ? '' : 's'}. `
      + `Tomorrow's prices typically publish around 13:00.`,
    ));
  }

  if (data.lastFetched) {
    const lastFetchedDate = new Date(data.lastFetched);
    const timeAgo = getTimeAgo(lastFetchedDate, context.now);
    priceList.appendChild(buildPriceNotice('price-last-fetched', `Last updated: ${timeAgo}`));
  }
};

const formatPriceTimeLabel = (entryTime: Date, currentHour: Date, now: Date) => {
  const timeStr = entryTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = entryTime.toDateString() !== now.toDateString()
    ? ` (${entryTime.toLocaleDateString([], { weekday: 'short' })})`
    : '';
  const nowLabel = entryTime.getTime() === currentHour.getTime() ? ' ← now' : '';
  return `${timeStr}${dateStr}${nowLabel}`;
};

const buildPriceTooltip = (entry: PriceEntry) => {
  const tooltipLines: string[] = [];
  if (typeof entry.spotPrice === 'number') {
    tooltipLines.push(`Spot: ${entry.spotPrice.toFixed(1)} øre`);
  }
  if (typeof entry.nettleie === 'number') {
    tooltipLines.push(`Nettleie: ${entry.nettleie.toFixed(1)} øre`);
  }
  if (typeof entry.spotPrice === 'number') {
    const surcharge = entry.total - entry.spotPrice - (entry.nettleie ?? 0);
    if (Math.abs(surcharge) >= 0.05) {
      tooltipLines.push(`Surcharge: ${surcharge.toFixed(1)} øre`);
    }
  }
  tooltipLines.push(`Total: ${entry.total.toFixed(1)} øre/kWh`);
  return tooltipLines.join('\n');
};

const buildPriceChip = (entry: PriceEntry, priceClass: string) => {
  const chip = document.createElement('span');
  chip.className = `chip ${priceClass}`;
  const priceStrong = document.createElement('strong');
  priceStrong.textContent = entry.total.toFixed(1);
  const priceUnit = document.createElement('span');
  priceUnit.textContent = 'øre/kWh';
  chip.append(priceStrong, priceUnit);
  chip.dataset.tooltip = buildPriceTooltip(entry);
  return chip;
};

const createPriceRow = (entry: PriceEntry, currentHour: Date, now: Date, priceClass: string) => {
  const entryTime = new Date(entry.startsAt);
  const isCurrentHour = entryTime.getTime() === currentHour.getTime();

  const row = createDeviceRow({
    name: formatPriceTimeLabel(entryTime, currentHour, now),
    className: 'price-row',
    controls: [buildPriceChip(entry, priceClass)],
    controlsClassName: 'device-row__target',
  });

  if (isCurrentHour) row.classList.add('current-hour');

  return row;
};

export const renderPrices = (data: CombinedPriceData | null) => {
  if (!priceList) return;
  priceList.innerHTML = '';

  if (!data || !data.prices || data.prices.length === 0) {
    if (priceEmpty) priceEmpty.hidden = false;
    setPriceStatusBadge('No data');
    return;
  }

  if (priceEmpty) priceEmpty.hidden = true;
  const context = buildPriceRenderContext(data);
  if (!context) {
    if (priceEmpty) priceEmpty.hidden = false;
    return;
  }

  if (context.currentEntry) {
    setPriceStatusBadge(`Now: ${context.currentEntry.total.toFixed(1)} øre/kWh`, 'ok');
  }

  renderPriceSections(context);
  renderPriceNotices(context, data);
};
