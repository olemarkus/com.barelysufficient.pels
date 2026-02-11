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
import {
  formatChipPrice,
  formatPriceWithUnit,
  formatSummaryPrice,
  getAverageTotal,
  groupPricesByDate,
  resolvePriceScheme,
  resolvePriceUnit,
  resolveThresholds,
  selectDayEntries,
  sortEntriesByStart,
  type PriceScheme,
} from './priceRenderUtils';
import { getPriceIndicatorIcon, type PriceIndicatorTone } from './priceIndicator';

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

const sortPricesByStart = (prices: PriceEntry[]) => (
  sortEntriesByStart(prices).map(({ entry }) => entry)
);

const findCurrentEntry = (prices: PriceEntry[], now: Date) => (
  prices.find((price) => isCurrentHourEntry(new Date(price.startsAt), now))
);

const buildPriceSummaryItem = (
  tone: PriceIndicatorTone,
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
  const cheapLimit = formatPriceWithUnit(
    formatSummaryPrice(context.lowThreshold, context.priceScheme),
    context.priceUnit,
  );
  const expensiveLimit = formatPriceWithUnit(
    formatSummaryPrice(context.highThreshold, context.priceScheme),
    context.priceUnit,
  );

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
    const detailText = `(cap <= ${cheapLimit}; cheapest: ${cheapestValue} at ${cheapestTime})`;
    summarySection.appendChild(buildPriceSummaryItem('cheap', context.cheapHours.length, 'cheap hour', detailText));
  } else {
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
    const detailText = `(cap >= ${expensiveLimit}; peak: ${expensiveValue} at ${expensiveTime})`;
    summarySection.appendChild(buildPriceSummaryItem(
      'expensive',
      context.expensiveHours.length,
      'expensive hour',
      detailText,
    ));
  } else {
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

const wrapPriceListItem = (content: HTMLElement, className = '') => {
  const item = document.createElement('li');
  item.className = ['price-list-item', className].filter(Boolean).join(' ');
  item.appendChild(content);
  return item;
};

type PriceRenderContext = {
  now: Date;
  allPrices: PriceEntry[];
  primaryEntries: PriceEntry[];
  secondaryEntries: PriceEntry[];
  primaryLabel: string;
  secondaryLabel: string | null;
  primaryAvg: number;
  secondaryAvg: number | null;
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

const createDayPriceSection = (
  label: string,
  icon: string,
  entries: PriceEntry[],
  avg: number,
  context: PriceRenderContext,
) => {
  const mappedEntries = entries.map((entry) => ({
    entry,
    priceClass: getPriceClass(entry),
  }));
  const details = document.createElement('details');
  details.className = 'price-details';
  const summary = document.createElement('summary');
  const avgPriceText = formatPriceWithUnit(
    formatSummaryPrice(avg, context.priceScheme),
    context.priceUnit,
  );
  summary.textContent = `${icon} ${label} (${entries.length} hours, avg ${avgPriceText})`;
  details.appendChild(summary);
  mappedEntries.forEach(({ entry, priceClass }) => {
    details.appendChild(createPriceRow(entry, priceClass, context));
  });
  return details;
};

const buildPriceRenderContext = (data: CombinedPriceData, timeZone: string): PriceRenderContext | null => {
  const priceScheme = resolvePriceScheme(data);
  const priceUnit = resolvePriceUnit(data, priceScheme);
  const now = new Date();
  const allPrices = sortPricesByStart(data.prices);
  if (allPrices.length === 0) return null;
  const currentHourStartMs = getHourStartInTimeZone(now, timeZone);
  const upcomingEntries = allPrices.filter((entry) => (
    new Date(entry.startsAt).getTime() >= currentHourStartMs
  ));
  const summaryEntries = upcomingEntries.length > 0 ? upcomingEntries : allPrices;

  const todayKey = getDateKeyInTimeZone(now, timeZone);
  const { entriesByDate, dayKeys } = groupPricesByDate(allPrices, timeZone);
  const {
    primaryEntries,
    secondaryEntries,
    primaryLabel,
    secondaryLabel,
  } = selectDayEntries({
    entriesByDate,
    dayKeys,
    todayKey,
    timeZone,
  });

  const cheapHours = summaryEntries.filter((price) => price.isCheap).sort((a, b) => a.total - b.total);
  const expensiveHours = summaryEntries.filter((price) => price.isExpensive).sort((a, b) => b.total - a.total);
  const { lowThreshold, highThreshold } = resolveThresholds(data);
  const primaryAvg = getAverageTotal(primaryEntries, data.avgPrice);
  const secondaryAvg = secondaryEntries.length > 0 ? getAverageTotal(secondaryEntries, data.avgPrice) : null;

  return {
    now,
    allPrices,
    primaryEntries,
    secondaryEntries,
    primaryLabel,
    secondaryLabel,
    primaryAvg,
    secondaryAvg,
    currentEntry: findCurrentEntry(allPrices, now),
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
  priceList.appendChild(wrapPriceListItem(buildPriceSummarySection(context), 'price-list-item--summary'));

  if (context.cheapHours.length > 0) {
    priceList.appendChild(
      wrapPriceListItem(buildPriceDetailsSection(
        `🟢 Cheap hours (${context.cheapHours.length})`,
        context.cheapHours,
        'price-low',
        context,
      ), 'price-list-item--details'),
    );
  }

  if (context.expensiveHours.length > 0) {
    priceList.appendChild(
      wrapPriceListItem(buildPriceDetailsSection(
        `🔴 Expensive hours (${context.expensiveHours.length})`,
        context.expensiveHours,
        'price-high',
        context,
      ), 'price-list-item--details'),
    );
  }

  priceList.appendChild(wrapPriceListItem(createDayPriceSection(
    context.primaryLabel,
    '📊',
    context.primaryEntries,
    context.primaryAvg,
    context,
  ), 'price-list-item--details'));

  if (context.secondaryEntries.length > 0 && context.secondaryLabel) {
    priceList.appendChild(wrapPriceListItem(createDayPriceSection(
      context.secondaryLabel,
      '📅',
      context.secondaryEntries,
      context.secondaryAvg ?? context.avgPrice,
      context,
    ), 'price-list-item--details'));
  }
};

const renderPriceNotices = (context: PriceRenderContext, data: CombinedPriceData) => {
  const lastPriceTime = new Date(context.allPrices[context.allPrices.length - 1].startsAt);
  const hoursRemaining = Math.max(
    0,
    Math.floor((lastPriceTime.getTime() - context.now.getTime()) / (1000 * 60 * 60)) + 1,
  );
  if (hoursRemaining > 0 && hoursRemaining <= 12) {
    const warningSuffix = context.priceScheme === 'norway'
      ? 'Tomorrow\'s prices typically publish around 13:00.'
      : 'Make sure your price source supplies tomorrow\'s prices.';
    priceList.appendChild(wrapPriceListItem(buildPriceNotice(
      'price-notice price-notice-warning',
      `⚠️ Price data available for ${hoursRemaining} more hour${hoursRemaining === 1 ? '' : 's'}. `
      + warningSuffix,
    )));
  }

  if (data.lastFetched) {
    const lastFetchedDate = new Date(data.lastFetched);
    const timeAgo = getTimeAgo(lastFetchedDate, context.now, context.timeZone);
    priceList.appendChild(wrapPriceListItem(buildPriceNotice('price-last-fetched', `Last updated: ${timeAgo}`)));
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
  return `${timeStr}${dateStr}`;
};

const getFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const sumExVatComponents = (entry: PriceEntry): number => (
  (entry.spotPriceExVat ?? 0)
  + (entry.gridTariffExVat ?? 0)
  + (entry.providerSurchargeExVat ?? 0)
  + (entry.consumptionTaxExVat ?? 0)
  + (entry.enovaFeeExVat ?? 0)
);

const resolveVatMultiplier = (entry: PriceEntry): number => {
  const direct = getFiniteNumber(entry.vatMultiplier);
  if (direct !== null) return direct;

  const totalExVat = getFiniteNumber(entry.totalExVat) ?? sumExVatComponents(entry);
  if (!Number.isFinite(totalExVat) || totalExVat <= 0) return 1;

  const vatAmount = getFiniteNumber(entry.vatAmount);
  if (vatAmount !== null) {
    const computed = 1 + vatAmount / totalExVat;
    return Number.isFinite(computed) && computed > 0 ? computed : 1;
  }

  const support = getFiniteNumber(entry.electricitySupport) ?? 0;
  const computed = (entry.total + support) / totalExVat;
  return Number.isFinite(computed) && computed > 0 ? computed : 1;
};

const buildPriceTooltip = (entry: PriceEntry, scheme: PriceScheme, priceUnit: string) => {
  const tooltipLines: string[] = [];
  const formatOre = (value: number) => `${value.toFixed(1)} øre`;

  const spotPrice = entry.spotPriceExVat;
  if (scheme === 'norway' && typeof spotPrice === 'number') {
    const vatMultiplier = resolveVatMultiplier(entry);
    const withVat = (priceExVat?: number) => (priceExVat ?? 0) * vatMultiplier;
    const gridTariff = withVat(entry.gridTariffExVat);
    const surcharge = withVat(entry.providerSurchargeExVat);
    const consumptionTax = withVat(entry.consumptionTaxExVat);
    const enovaFee = withVat(entry.enovaFeeExVat);
    const norgesprisAdjustment = getFiniteNumber(entry.norgesprisAdjustment);
    const support = entry.electricitySupport ?? 0;

    tooltipLines.push(`Spot price: ${formatOre(withVat(spotPrice))}`);
    tooltipLines.push(`Grid tariff: ${formatOre(gridTariff)}`);
    tooltipLines.push(`Provider surcharge: ${formatOre(surcharge)}`);
    tooltipLines.push(`Consumption tax: ${formatOre(consumptionTax)}`);
    tooltipLines.push(`Enova fee: ${formatOre(enovaFee)}`);
    if (norgesprisAdjustment !== null) {
      tooltipLines.push(`Norway Price adjustment: ${formatOre(norgesprisAdjustment)}`);
    } else {
      tooltipLines.push(`Electricity subsidy: -${formatOre(support)}`);
    }
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

const buildNowBadge = () => {
  const badge = document.createElement('span');
  badge.className = 'price-now-badge';
  badge.textContent = 'Now';
  return badge;
};

const createPriceRow = (
  entry: PriceEntry,
  priceClass: string,
  timeContext: PriceTimeContext,
) => {
  const entryTime = new Date(entry.startsAt);
  const isCurrentHour = isCurrentHourEntry(entryTime, timeContext.now);
  const controls: HTMLElement[] = [];
  if (isCurrentHour) {
    controls.push(buildNowBadge());
  }
  controls.push(buildPriceChip(entry, priceClass, timeContext.priceScheme, timeContext.priceUnit));

  const row = createDeviceRow({
    name: formatPriceTimeLabel(entryTime, timeContext),
    className: 'price-row',
    controls,
    controlsClassName: 'device-row__target',
    element: 'div',
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
