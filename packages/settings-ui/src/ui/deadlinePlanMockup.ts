import { callApi } from './homey.ts';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_PRICES_PATH,
  type SettingsUiBootstrap,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  renderDeadlinePlanMockup,
  type DeadlinePlanMockupLoadState,
  type DeadlinePlanMockupPayload,
} from './views/DeadlinePlanMockup.tsx';

export const isDeadlinePlanMockupPage = (): boolean => (
  document.getElementById('deadline-plan-mockup-root') !== null
);

type PriceEntryLike = {
  startsAt?: unknown;
  total?: unknown;
  isCheap?: unknown;
  isExpensive?: unknown;
};

type CombinedPricesLike = {
  prices?: unknown;
};

type DeadlinePlanHourPreview = Omit<DeadlinePlanMockupPayload['timeline']['hours'][number], 'price' | 'time'> & {
  startsAt: string;
};

type DeadlinePlanMockupSettings = Omit<DeadlinePlanMockupPayload, 'timeline'> & {
  timeline: Omit<DeadlinePlanMockupPayload['timeline'], 'hours'> & {
    hours: DeadlinePlanHourPreview[];
  };
};

const isRecord = (candidate: unknown): candidate is Record<string, unknown> => (
  Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate)
);

const isString = (candidate: unknown): candidate is string => (
  typeof candidate === 'string' && candidate.trim().length > 0
);

const isChipTone = (candidate: unknown): candidate is DeadlinePlanMockupPayload['hero']['chips'][number]['tone'] => (
  candidate === 'info' || candidate === 'muted' || candidate === 'ok' || candidate === 'warn'
);

const isPlan = (candidate: unknown): candidate is DeadlinePlanHourPreview['plan'] => (
  candidate === undefined || candidate === 'Charge' || candidate === 'Fallback'
);

const isUsage = (candidate: unknown): candidate is NonNullable<DeadlinePlanHourPreview['usage']> => (
  candidate === undefined
  || (
    isRecord(candidate)
    && typeof candidate.otherKwh === 'number'
    && Number.isFinite(candidate.otherKwh)
    && typeof candidate.chargerKwh === 'number'
    && Number.isFinite(candidate.chargerKwh)
    && typeof candidate.hardCapKwh === 'number'
    && Number.isFinite(candidate.hardCapKwh)
  )
);

const isPreviewHour = (candidate: unknown): candidate is DeadlinePlanHourPreview => (
  isRecord(candidate)
  && isString(candidate.startsAt)
  && isPlan(candidate.plan)
  && isUsage(candidate.usage)
  && (
    candidate.progress === undefined
    || (typeof candidate.progress === 'number' && Number.isFinite(candidate.progress))
  )
);

const hasValidHero = (candidate: Record<string, unknown>): candidate is {
  hero: DeadlinePlanMockupSettings['hero'];
} => (
  isRecord(candidate.hero)
  && Array.isArray(candidate.hero.chips)
  && candidate.hero.chips.every((chip) => (
    isRecord(chip)
    && isString(chip.text)
    && isChipTone(chip.tone)
  ))
  && isString(candidate.hero.sectionLabel)
  && isString(candidate.hero.headline)
  && isString(candidate.hero.subline)
  && isString(candidate.hero.decision)
);

const hasValidTimeline = (candidate: Record<string, unknown>): candidate is {
  timeline: DeadlinePlanMockupSettings['timeline'];
} => (
  isRecord(candidate.timeline)
  && isString(candidate.timeline.title)
  && isString(candidate.timeline.subtitle)
  && isString(candidate.timeline.ariaLabel)
  && isString(candidate.timeline.explainer)
  && Array.isArray(candidate.timeline.hours)
  && candidate.timeline.hours.length > 0
  && candidate.timeline.hours.every(isPreviewHour)
);

const isSettings = (candidate: unknown): candidate is DeadlinePlanMockupSettings => (
  isRecord(candidate)
  && hasValidHero(candidate)
  && hasValidTimeline(candidate)
);

const renderState = (surface: HTMLElement, loadState: DeadlinePlanMockupLoadState): void => {
  renderDeadlinePlanMockup(surface, loadState);
};

const getCombinedPrices = (payload: SettingsUiPricesPayload): PriceEntryLike[] => {
  const combined = payload.combinedPrices as CombinedPricesLike | null;
  return Array.isArray(combined?.prices) ? combined.prices as PriceEntryLike[] : [];
};

const formatHour = (startsAt: string): string => {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return startsAt.slice(11, 13) || startsAt;
  return date.toLocaleTimeString([], { hour: '2-digit', hour12: false });
};

const formatPrice = (total: unknown): string => (
  typeof total === 'number' && Number.isFinite(total) ? total.toFixed(2) : ''
);

type DeadlinePlanHourTone = DeadlinePlanMockupPayload['timeline']['hours'][number]['tone'];

const resolvePriceTone = (entry: PriceEntryLike | undefined): DeadlinePlanHourTone => {
  if (entry?.isCheap === true) return 'cheap';
  if (entry?.isExpensive === true) return 'expensive';
  return 'normal';
};

const resolvePriceLevel = (
  entry: PriceEntryLike | undefined,
  minTotal: number,
  maxTotal: number,
): number => {
  if (typeof entry?.total !== 'number' || !Number.isFinite(entry.total)) return 40;
  const range = Math.max(1, maxTotal - minTotal);
  return Math.round(((entry.total - minTotal) / range) * 100);
};

const buildPayload = (
  bootstrap: SettingsUiBootstrap,
  prices: SettingsUiPricesPayload,
): DeadlinePlanMockupPayload | null => {
  const settings = (bootstrap.settings as Record<string, unknown>).deferred_objective_preview;
  if (!isSettings(settings)) return null;

  const priceEntries = getCombinedPrices(prices);
  const finiteTotals = priceEntries
    .map((entry) => entry.total)
    .filter((total): total is number => typeof total === 'number' && Number.isFinite(total));
  const minTotal = finiteTotals.length > 0 ? Math.min(...finiteTotals) : 0;
  const maxTotal = finiteTotals.length > 0 ? Math.max(...finiteTotals) : 1;
  const pricesByStart = new Map(
    priceEntries
      .filter((entry): entry is PriceEntryLike & { startsAt: string } => typeof entry.startsAt === 'string')
      .map((entry) => [entry.startsAt, entry]),
  );

  return {
    ...settings,
    timeline: {
      ...settings.timeline,
      hours: settings.timeline.hours.map((hour) => {
        const price = pricesByStart.get(hour.startsAt);
        return {
          ...hour,
          time: formatHour(hour.startsAt),
          price: formatPrice(price?.total),
          priceLevel: resolvePriceLevel(price, minTotal, maxTotal),
          tone: resolvePriceTone(price),
        };
      }),
    },
  };
};

export const mountDeadlinePlanMockup = async (): Promise<void> => {
  const surface = document.getElementById('deadline-plan-mockup-root');
  if (!surface) return;

  renderState(surface, { status: 'loading' });
  try {
    const bootstrap = await callApi<SettingsUiBootstrap>('GET', SETTINGS_UI_BOOTSTRAP_PATH);
    let prices = bootstrap.prices;
    try {
      prices = await callApi<SettingsUiPricesPayload>('GET', SETTINGS_UI_PRICES_PATH);
    } catch {
      prices = bootstrap.prices;
    }
    const payload = buildPayload(bootstrap, prices);
    renderState(surface, payload
      ? { status: 'ready', payload }
      : { status: 'error', message: 'Deadline plan data is not available.' });
  } catch {
    renderState(surface, { status: 'error', message: 'Deadline plan data is not available.' });
  }
};
