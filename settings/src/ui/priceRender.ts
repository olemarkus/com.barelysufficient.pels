import { priceList, priceEmpty, priceStatusBadge } from './dom';
import { getTimeAgo } from './utils';
import { getHomeyTimezone } from './homey';
import type { CombinedPriceData, PriceEntry } from './priceTypes';
import { createDeviceRow } from './components';
import {
  formatDateInTimeZone,
  formatTimeInTimeZone,
  getDateKeyInTimeZone,
  getHourStartInTimeZone,
} from './timezone';

const setPriceStatusBadge = (text: string, statusClass?: 'ok' | 'warn') => {
  if (!priceStatusBadge) return;
  priceStatusBadge.textContent = text;
  priceStatusBadge.classList.remove('ok', 'warn');
  if (statusClass) {
    priceStatusBadge.classList.add(statusClass);
  }
};

const HOUR_MS = 60 * 60 * 1000;

const isCurrentHourEntry = (entryTime: Date, now: Date) => {
  const start = entryTime.getTime();
  const nowMs = now.getTime();
  return nowMs >= start && nowMs < start + HOUR_MS;
};

const getCurrentHour = (now: Date, timeZone: string) => (
  new Date(getHourStartInTimeZone(now, timeZone))
);

const getFuturePrices = (prices: PriceEntry[], currentHour: Date) => (
  prices.filter((price) => new Date(price.startsAt) >= currentHour)
);

const findCurrentEntry = (prices: PriceEntry[], now: Date) => (
  prices.find((price) => isCurrentHourEntry(new Date(price.startsAt), now))
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
  timeZone: string,
) => {
  const summarySection = document.createElement('div');
  summarySection.className = 'price-summary';

  if (cheapHours.length > 0) {
    const cheapest = cheapHours[0];
    const cheapestTime = formatTimeInTimeZone(new Date(cheapest.startsAt), { hour: '2-digit', minute: '2-digit' }, timeZone);
    const detailText = `(cheapest: ${cheapest.total.toFixed(0)} øre at ${cheapestTime})`;
    summarySection.appendChild(buildPriceSummaryItem('cheap', cheapHours.length, 'cheap hour', detailText));
  } else {
    summarySection.appendChild(
      buildPriceSummaryItem('neutral', null, '', `No cheap hours (<${thresholdPct}% below avg)`),
    );
  }

  if (expensiveHours.length > 0) {
    const mostExpensive = expensiveHours[0];
    const expensiveTime = formatTimeInTimeZone(new Date(mostExpensive.startsAt), { hour: '2-digit', minute: '2-digit' }, timeZone);
    const detailText = `(peak: ${mostExpensive.total.toFixed(0)} øre at ${expensiveTime})`;
    summarySection.appendChild(buildPriceSummaryItem('expensive', expensiveHours.length, 'expensive hour', detailText));
  } else {
    summarySection.appendChild(
      buildPriceSummaryItem('neutral', null, '', `No expensive hours (>${thresholdPct}% above avg)`),
    );
  }

  return summarySection;
};

type PriceTimeContext = {
  now: Date;
  timeZone: string;
};

const buildPriceDetailsSection = (
  title: string,
  entries: PriceEntry[],
  priceClass: string,
  timeContext: PriceTimeContext,
) => {
  const details = document.createElement('details');
  details.className = 'price-details';
  const summary = document.createElement('summary');
  summary.textContent = title;
  details.appendChild(summary);
  entries.forEach((entry) => {
    details.appendChild(createPriceRow(entry, priceClass, timeContext));
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
  futurePrices: PriceEntry[];
  currentEntry?: PriceEntry;
  cheapHours: PriceEntry[];
  expensiveHours: PriceEntry[];
  thresholdPct: number;
  avgPrice: number;
  timeZone: string;
};

const buildPriceRenderContext = (data: CombinedPriceData, timeZone: string): PriceRenderContext | null => {
  const now = new Date();
  const currentHour = getCurrentHour(now, timeZone);
  const futurePrices = getFuturePrices(data.prices, currentHour);
  if (futurePrices.length === 0) return null;

  const cheapHours = futurePrices.filter((price) => price.isCheap).sort((a, b) => a.total - b.total);
  const expensiveHours = futurePrices.filter((price) => price.isExpensive).sort((a, b) => b.total - a.total);

  return {
    now,
    futurePrices,
    currentEntry: findCurrentEntry(data.prices, now),
    cheapHours,
    expensiveHours,
    thresholdPct: data.thresholdPercent ?? 25,
    avgPrice: data.avgPrice,
    timeZone,
  };
};

const renderPriceSections = (context: PriceRenderContext) => {
  priceList.appendChild(buildPriceSummarySection(
    context.cheapHours,
    context.expensiveHours,
    context.thresholdPct,
    context.timeZone,
  ));

  if (context.cheapHours.length > 0) {
    priceList.appendChild(
      buildPriceDetailsSection(
        `🟢 Cheap hours (${context.cheapHours.length})`,
        context.cheapHours,
        'price-low',
        context,
      ),
    );
  }

  if (context.expensiveHours.length > 0) {
    priceList.appendChild(
      buildPriceDetailsSection(
        `🔴 Expensive hours (${context.expensiveHours.length})`,
        context.expensiveHours,
        'price-high',
        context,
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
    allDetails.appendChild(createPriceRow(entry, priceClass, context));
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
    const timeAgo = getTimeAgo(lastFetchedDate, context.now, context.timeZone);
    priceList.appendChild(buildPriceNotice('price-last-fetched', `Last updated: ${timeAgo}`));
  }
};

const formatPriceTimeLabel = (entryTime: Date, timeContext: PriceTimeContext) => {
  const { now, timeZone } = timeContext;
  const timeStr = formatTimeInTimeZone(entryTime, { hour: '2-digit', minute: '2-digit' }, timeZone);
  const entryKey = getDateKeyInTimeZone(entryTime, timeZone);
  const nowKey = getDateKeyInTimeZone(now, timeZone);
  const dateStr = entryKey !== nowKey
    ? ` (${formatDateInTimeZone(entryTime, { weekday: 'short' }, timeZone)})`
    : '';
  const nowLabel = isCurrentHourEntry(entryTime, now) ? ' ← now' : '';
  return `${timeStr}${dateStr}${nowLabel}`;
};

const buildPriceTooltip = (entry: PriceEntry) => {
  const tooltipLines: string[] = [];
  const formatOre = (value: number) => `${value.toFixed(1)} øre`;
  const hasBreakdown = typeof entry.spotPriceExVat === 'number';

  if (hasBreakdown) {
    const gridTariff = entry.gridTariffExVat ?? 0;
    const surcharge = entry.providerSurchargeExVat ?? 0;
    const consumptionTax = entry.consumptionTaxExVat ?? 0;
    const enovaFee = entry.enovaFeeExVat ?? 0;
    const vatAmount = entry.vatAmount ?? 0;
    const support = entry.electricitySupport ?? 0;
    const vatLabel = entry.vatMultiplier === 1 ? 'VAT (0%)' : 'VAT';

    tooltipLines.push(`Spot price (ex VAT): ${formatOre(entry.spotPriceExVat)}`);
    tooltipLines.push(`Grid tariff (ex VAT): ${formatOre(gridTariff)}`);
    tooltipLines.push(`Provider surcharge (ex VAT): ${formatOre(surcharge)}`);
    tooltipLines.push(`Consumption tax: ${formatOre(consumptionTax)}`);
    tooltipLines.push(`Enova fee: ${formatOre(enovaFee)}`);
    tooltipLines.push(`${vatLabel}: ${formatOre(vatAmount)}`);
    tooltipLines.push(`Electricity support: -${formatOre(support)}`);
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

const createPriceRow = (entry: PriceEntry, priceClass: string, timeContext: PriceTimeContext) => {
  const entryTime = new Date(entry.startsAt);
  const isCurrentHour = isCurrentHourEntry(entryTime, timeContext.now);

  const row = createDeviceRow({
    name: formatPriceTimeLabel(entryTime, timeContext),
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
  const timeZone = getHomeyTimezone();
  const context = buildPriceRenderContext(data, timeZone);
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
