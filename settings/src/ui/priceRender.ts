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
import { calculateThresholds } from './priceThresholds';

const setPriceStatusBadge = (text: string, statusClass?: 'ok' | 'warn') => {
  if (!priceStatusBadge) return;
  priceStatusBadge.textContent = text;
  priceStatusBadge.classList.remove('ok', 'warn');
  if (statusClass) {
    priceStatusBadge.classList.add(statusClass);
  }
};

type PriceScheme = 'norway' | 'flow';

const resolvePriceScheme = (data: CombinedPriceData): PriceScheme => (
  data.priceScheme === 'flow' ? 'flow' : 'norway'
);

const resolvePriceUnit = (data: CombinedPriceData, scheme: PriceScheme): string => (
  scheme === 'flow' ? '' : (data.priceUnit || 'øre/kWh')
);

const formatPriceValue = (value: number, decimals: number): string => (
  value.toFixed(decimals)
);

const formatSummaryPrice = (value: number, scheme: PriceScheme): string => (
  formatPriceValue(value, scheme === 'flow' ? 4 : 0)
);

const formatChipPrice = (value: number, scheme: PriceScheme): string => (
  formatPriceValue(value, scheme === 'flow' ? 4 : 1)
);

const formatPriceWithUnit = (value: string, unit: string): string => (
  unit ? `${value} ${unit}` : value
);

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

const buildPriceSummarySection = (context: PriceRenderContext) => {
  const summarySection = document.createElement('div');
  summarySection.className = 'price-summary';

  if (context.cheapHours.length > 0) {
    const cheapest = context.cheapHours[0];
    const cheapestTime = formatTimeInTimeZone(
      new Date(cheapest.startsAt),
      { hour: '2-digit', minute: '2-digit' },
      context.timeZone,
    );
    const cheapestValue = formatPriceWithUnit(
      formatSummaryPrice(cheapest.total, context.priceScheme),
      context.priceUnit,
    );
    const detailText = `(cheapest: ${cheapestValue} at ${cheapestTime})`;
    summarySection.appendChild(buildPriceSummaryItem('cheap', context.cheapHours.length, 'cheap hour', detailText));
  } else {
    const cheapLimit = formatPriceWithUnit(
      formatSummaryPrice(context.lowThreshold, context.priceScheme),
      context.priceUnit,
    );
    summarySection.appendChild(
      buildPriceSummaryItem('neutral', null, '', `No cheap hours (at or below ${cheapLimit})`),
    );
  }

  if (context.expensiveHours.length > 0) {
    const mostExpensive = context.expensiveHours[0];
    const expensiveTime = formatTimeInTimeZone(
      new Date(mostExpensive.startsAt),
      { hour: '2-digit', minute: '2-digit' },
      context.timeZone,
    );
    const expensiveValue = formatPriceWithUnit(
      formatSummaryPrice(mostExpensive.total, context.priceScheme),
      context.priceUnit,
    );
    const detailText = `(peak: ${expensiveValue} at ${expensiveTime})`;
    summarySection.appendChild(buildPriceSummaryItem(
      'expensive',
      context.expensiveHours.length,
      'expensive hour',
      detailText,
    ));
  } else {
    const expensiveLimit = formatPriceWithUnit(
      formatSummaryPrice(context.highThreshold, context.priceScheme),
      context.priceUnit,
    );
    summarySection.appendChild(
      buildPriceSummaryItem('neutral', null, '', `No expensive hours (at or above ${expensiveLimit})`),
    );
  }

  return summarySection;
};

type PriceTimeContext = {
  now: Date;
  timeZone: string;
  priceScheme: PriceScheme;
  priceUnit: string;
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
  lowThreshold: number;
  highThreshold: number;
  avgPrice: number;
  timeZone: string;
  priceUnit: string;
  priceScheme: PriceScheme;
};

const buildPriceRenderContext = (data: CombinedPriceData, timeZone: string): PriceRenderContext | null => {
  const priceScheme = resolvePriceScheme(data);
  const priceUnit = resolvePriceUnit(data, priceScheme);
  const now = new Date();
  const currentHour = getCurrentHour(now, timeZone);
  const futurePrices = getFuturePrices(data.prices, currentHour);
  if (futurePrices.length === 0) return null;

  const cheapHours = futurePrices.filter((price) => price.isCheap).sort((a, b) => a.total - b.total);
  const expensiveHours = futurePrices.filter((price) => price.isExpensive).sort((a, b) => b.total - a.total);
  const thresholdPct = data.thresholdPercent ?? 25;
  const derivedThresholds = calculateThresholds(data.avgPrice, thresholdPct);
  const baseLowThreshold = Number.isFinite(data.lowThreshold)
    ? data.lowThreshold
    : derivedThresholds.low;
  const baseHighThreshold = Number.isFinite(data.highThreshold)
    ? data.highThreshold
    : derivedThresholds.high;
  const minDiff = typeof data.minDiffOre === 'number' && Number.isFinite(data.minDiffOre)
    ? data.minDiffOre
    : 0;
  const lowThreshold = minDiff > 0
    ? Math.min(baseLowThreshold, data.avgPrice - minDiff)
    : baseLowThreshold;
  const highThreshold = minDiff > 0
    ? Math.max(baseHighThreshold, data.avgPrice + minDiff)
    : baseHighThreshold;

  return {
    now,
    futurePrices,
    currentEntry: findCurrentEntry(data.prices, now),
    cheapHours,
    expensiveHours,
    lowThreshold,
    highThreshold,
    avgPrice: data.avgPrice,
    timeZone,
    priceUnit,
    priceScheme,
  };
};

const renderPriceSections = (context: PriceRenderContext) => {
  priceList.appendChild(buildPriceSummarySection(context));

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
  const avgPriceText = formatPriceWithUnit(
    formatSummaryPrice(context.avgPrice, context.priceScheme),
    context.priceUnit,
  );
  allSummary.textContent = `📊 All prices (${context.futurePrices.length} hours, avg ${avgPriceText})`;
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
    const warningSuffix = context.priceScheme === 'flow'
      ? 'Make sure your flow supplies tomorrow\'s prices.'
      : 'Tomorrow\'s prices typically publish around 13:00.';
    priceList.appendChild(buildPriceNotice(
      'price-notice price-notice-warning',
      `⚠️ Price data available for ${hoursRemaining} more hour${hoursRemaining === 1 ? '' : 's'}. `
      + warningSuffix,
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

const buildPriceTooltip = (entry: PriceEntry, scheme: PriceScheme, priceUnit: string) => {
  const tooltipLines: string[] = [];
  const formatOre = (value: number) => `${value.toFixed(1)} øre`;

  const spotPrice = entry.spotPriceExVat;
  if (scheme !== 'flow' && typeof spotPrice === 'number') {
    const gridTariff = entry.gridTariffExVat ?? 0;
    const surcharge = entry.providerSurchargeExVat ?? 0;
    const consumptionTax = entry.consumptionTaxExVat ?? 0;
    const enovaFee = entry.enovaFeeExVat ?? 0;
    const vatAmount = entry.vatAmount ?? 0;
    const support = entry.electricitySupport ?? 0;
    const vatLabel = entry.vatMultiplier === 1 ? 'VAT (0%)' : 'VAT';

    tooltipLines.push(`Spot price (ex VAT): ${formatOre(spotPrice)}`);
    tooltipLines.push(`Grid tariff (ex VAT): ${formatOre(gridTariff)}`);
    tooltipLines.push(`Provider surcharge (ex VAT): ${formatOre(surcharge)}`);
    tooltipLines.push(`Consumption tax: ${formatOre(consumptionTax)}`);
    tooltipLines.push(`Enova fee: ${formatOre(enovaFee)}`);
    tooltipLines.push(`${vatLabel}: ${formatOre(vatAmount)}`);
    tooltipLines.push(`Electricity support: -${formatOre(support)}`);
  }

  tooltipLines.push(`Total: ${formatPriceWithUnit(formatChipPrice(entry.total, scheme), priceUnit)}`);
  return tooltipLines.join('\n');
};

const buildPriceChip = (entry: PriceEntry, priceClass: string, scheme: PriceScheme, priceUnit: string) => {
  const chip = document.createElement('span');
  chip.className = `chip ${priceClass}`;
  const priceStrong = document.createElement('strong');
  priceStrong.textContent = formatChipPrice(entry.total, scheme);
  chip.append(priceStrong);
  if (priceUnit) {
    const priceUnitEl = document.createElement('span');
    priceUnitEl.textContent = priceUnit;
    chip.appendChild(priceUnitEl);
  }
  chip.dataset.tooltip = buildPriceTooltip(entry, scheme, priceUnit);
  return chip;
};

const createPriceRow = (
  entry: PriceEntry,
  priceClass: string,
  timeContext: PriceTimeContext,
) => {
  const entryTime = new Date(entry.startsAt);
  const isCurrentHour = isCurrentHourEntry(entryTime, timeContext.now);

  const row = createDeviceRow({
    name: formatPriceTimeLabel(entryTime, timeContext),
    className: 'price-row',
    controls: [buildPriceChip(entry, priceClass, timeContext.priceScheme, timeContext.priceUnit)],
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
    const nowPrice = formatPriceWithUnit(
      formatChipPrice(context.currentEntry.total, context.priceScheme),
      context.priceUnit,
    );
    setPriceStatusBadge(
      `Now: ${nowPrice}`,
      'ok',
    );
  }

  renderPriceSections(context);
  renderPriceNotices(context, data);
};
