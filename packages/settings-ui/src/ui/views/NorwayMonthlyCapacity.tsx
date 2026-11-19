import { render } from 'preact';
import type {
  NorwayMonthlyCapacityRead, NorwayCapacityDailyPeak, NorwayCapacityChoiceState,
} from '../../../../contracts/src/norwayMonthlyCapacity.ts';
import { MdElevation, MdFilledTonalButton, MdOutlinedButton, MdTextButton } from './materialWebJSX.tsx';
import { ExpandMoreIcon } from './icons.tsx';

const TIME_ZONE = 'Europe/Oslo';
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export const kw = (value: number): string => `${number.format(value)} kW`;
export const capacityTierText = (tier: { lowerKw: number; upperKw: number | null }): string => (
  tier.upperKw === null ? `${kw(tier.lowerKw)} and above` : `${number.format(tier.lowerKw)}–${kw(tier.upperKw)} tier`
);
type ReadyRead = Extract<NorwayMonthlyCapacityRead, { state: 'ready' }>;
const resetDate = (monthKey: string): string => {
  const date = new Date(`${monthKey}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', timeZone: TIME_ZONE,
  });
};
const monthLabel = (key: string): string => new Date(`${key}-15T12:00:00Z`)
  .toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: TIME_ZONE });
const peakLabel = (atMs: number): string => new Date(atMs)
  .toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: TIME_ZONE });
const hourLabel = (atMs: number): string => new Date(atMs)
  .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TIME_ZONE });
const todayKey = (nowMs: number): string => new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(nowMs);

const lowerBoundKw = (value: number): string => kw(Math.floor(value * 100 + 1e-9) / 100);
const peakPowerText = (peak: NorwayCapacityDailyPeak): string => (
  peak.lowerBound ? `≥ ${lowerBoundKw(peak.kw)}` : kw(peak.kw)
);
const peakEvidence = (read: ReadyRead): string => {
  if (read.average.state === 'recorded') {
    const average = read.peaks.some((peak) => peak.lowerBound)
      ? `at least ${lowerBoundKw(read.average.kw)}` : kw(read.average.kw);
    return `Your top three daily peaks average ${average}.`;
  }
  const peak = read.peaks[0];
  if (!peak) return 'Your tier uses the three highest hourly averages on different days.';
  const power = peak.lowerBound ? `at least ${lowerBoundKw(peak.kw)}` : kw(peak.kw);
  return `Your highest recorded hour is ${power}. Your tier uses one peak hour from each of three days.`;
};

const capReason = (read: ReadyRead): string => {
  if (read.remainingMonthCap.state === 'unbounded_tier') return 'There is no upper tariff boundary for this target.';
  if (read.targetLost && read.targetBoundaryKw !== null) {
    const loss = `The tier below ${kw(read.targetBoundaryKw)} is already out of reach this month.`;
    return read.remainingMonthCap.state === 'bounded'
      ? `${loss} This hourly cap targets the ${capacityTierText(read.tier)}.` : loss;
  }
  if (read.targetBoundaryKw === null || read.remainingMonthCap.state !== 'bounded') return '';
  const thirdPeak = read.peaks[2];
  if (thirdPeak && !thirdPeak.lowerBound) {
    return `A higher day can replace the ${kw(thirdPeak.kw)} peak. The ${kw(read.remainingMonthCap.limitKw)} hourly cap helps keep that average below ${kw(read.targetBoundaryKw)}.`;
  }
  return `Keeping future hours within this cap helps keep your monthly average below ${kw(read.targetBoundaryKw)}.`;
};

export const MonthlyCapacityOverview = ({ read }: { read?: NorwayMonthlyCapacityRead }) => {
  if (!read || read.state !== 'ready' || read.targetBoundaryKw === null
    || read.advice.state !== 'suggestion' || !read.advice.actionable) return null;
  return <section class="pels-surface-card monthly-capacity-overview">
    <MdElevation aria-hidden="true" />
    <h3 class="plan-card__title">{read.advice.direction === 'lower' ? 'Lower' : 'Raise'} this month’s Hard cap to {kw(read.advice.limitKw)}?</h3>
    <p class="monthly-capacity-copy">{read.targetLost ? capReason(read)
      : `Based on your recorded daily peaks, this cap helps keep the monthly average below ${kw(read.targetBoundaryKw)}.`}</p>
    <MdTextButton class="monthly-capacity-nav" type="button" data-settings-target="usage">Review monthly cap</MdTextButton>
  </section>;
};

const RemainingMonthCap = ({ limitKw }: { limitKw: number }) => (
  <div class="monthly-capacity-limit">
    <span class="pels-card-supporting">Hourly cap this month</span>
    <strong>≤ {kw(limitKw)}</strong>
  </div>
);
const PeakHours = ({ peaks, nowMs }: { peaks: ReadyRead['peaks']; nowMs: number }) => (
  <ol class="monthly-capacity-peaks" aria-label="Three highest daily hours">
      {Array.from({ length: 3 }, (_, index) => {
        const peak = peaks[index];
        return <li key={index}>
          <span>{index + 1}. {peak ? <>{peakLabel(peak.hourStartMs)}
            {peak.dateKey === todayKey(nowMs) ? ' · today' : ''}{' '}
            <span class="pels-card-supporting">{hourLabel(peak.hourStartMs)}–{hourLabel(peak.hourStartMs + 3_600_000)}
              {peak.lowerBound && ' · partial hour'}</span></> : 'Not recorded'}</span>
          {peak && <strong>{peakPowerText(peak)}</strong>}
        </li>;
      })}
  </ol>
);

export type MonthlyCapacityActionView = {
  choice?: NorwayCapacityChoiceState;
  busy?: boolean;
  message?: string;
  onApply?: () => void;
  onCancel?: () => void;
};
export const MonthlyCapacityActions = ({ read, choice, busy, message, onApply, onCancel }:
  MonthlyCapacityActionView & { read: NorwayMonthlyCapacityRead }) => (
  <>
    {choice?.state === 'active' && <div class="monthly-capacity-choice">
      <p class="monthly-capacity-copy"><strong>{kw(choice.offer.limitKw)} Hard cap in use.</strong>{' '}
        Your normal {kw(choice.normalLimitKw)} Hard cap returns on {resetDate(choice.offer.monthKey)}.</p>
      <MdTextButton type="button" {...(busy ? { disabled: true } : {})} onClick={onCancel}>
        Use normal limit now
      </MdTextButton>
    </div>}
    {read.state === 'ready' && read.advice.state === 'suggestion' && read.advice.actionable && <div class="monthly-capacity-action">
      {choice?.state !== 'active' && <p class="pels-card-supporting">
        Normal cap resumes on {resetDate(read.monthKey)}.
      </p>}
      <MdFilledTonalButton type="button" {...(busy ? { disabled: true } : {})} onClick={onApply}>
        {busy ? 'Saving monthly limit…' : `Use ${kw(read.advice.limitKw)} this month`}
      </MdFilledTonalButton>
    </div>}
    {message && <p class="pels-card-supporting" role="status">{message}</p>}
  </>
);

const CapacitySummary = ({ read, choice }: { read: ReadyRead; choice?: NorwayCapacityChoiceState }) => {
  const cap = read.remainingMonthCap;
  const recommendation = read.hardCapRecommendation;
  return <>
    <p class="monthly-capacity-copy">{peakEvidence(read)}{' '}{capReason(read)}</p>
    {cap.state === 'bounded' && <RemainingMonthCap limitKw={cap.limitKw} />}
    {cap.state === 'keep_current' && <p class="monthly-capacity-copy">Keep the current Hard cap of {kw(cap.limitKw)} while the average is close to the tier boundary.</p>}
    {cap.state === 'no_positive_limit' && <p class="monthly-capacity-copy">The recorded peaks leave no positive hourly cap for this target.</p>}
    {recommendation.state === 'keep' && choice?.state !== 'active'
      && <p class="monthly-capacity-copy">Keep Hard cap at <strong>{kw(recommendation.limitKw)}</strong>.</p>}
    {read.coverage === 'partial' && <p class="pels-card-supporting">Some hours are missing. Your billed tier could be higher.</p>}
  </>;
};

export const MonthlyCapacityCard = ({ read, nowMs, ...actions }:
  MonthlyCapacityActionView & { read: NorwayMonthlyCapacityRead; nowMs: number }) => {
  if (read.state === 'hidden') return null;
  if (read.state === 'unavailable') return <section class="pels-surface-card usage-card" id="monthly-capacity-card">
    <MdElevation aria-hidden="true" />
    <h3 class="plan-card__title">Monthly capacity</h3>
    <p class="pels-card-supporting">{read.reason === 'grid_company'
      ? 'Choose your grid company to see its capacity tiers.'
      : read.reason === 'timezone' ? 'Monthly capacity uses Norwegian calendar days. Set Homey’s timezone to Europe/Oslo.'
        : 'Capacity tier information is unavailable for your selected grid tariff.'}</p>
    {read.reason === 'grid_company' && <MdOutlinedButton type="button" data-settings-target="electricity-prices">Choose grid company</MdOutlinedButton>}
  </section>;
  return <section class="pels-surface-card usage-card monthly-capacity-card" id="monthly-capacity-card">
    <MdElevation aria-hidden="true" />
    <header class="monthly-capacity-heading">
      <h3 class="plan-card__title">Monthly capacity</h3>
      <span class="pels-card-supporting">{monthLabel(read.monthKey)}</span>
    </header>
    <p class="pels-text-card-title monthly-capacity-copy">{read.average.state === 'recorded'
      ? `Estimated ${capacityTierText(read.tier)}`
      : `${read.average.days} of 3 daily peaks recorded`}</p>
    <CapacitySummary read={read} choice={actions.choice} />
    <MonthlyCapacityActions read={read} {...actions} />
    <details class="monthly-capacity-details">
      <summary>Three highest daily hours<ExpandMoreIcon class="disclosure-chevron" /></summary>
      <PeakHours peaks={read.peaks} nowMs={nowMs} />
      {read.hardCapRecommendation.state !== 'none' && <p class="pels-card-supporting">
        PELS reserves {kw(read.hardCapRecommendation.marginKw)} below the Hard cap for unmanaged usage late in the hour.
      </p>}
      {read.coverage === 'partial' && <MdTextButton class="monthly-capacity-nav" type="button"
        data-settings-target="advanced" data-settings-anchor="#power-history-recovery">Recover missing hours</MdTextButton>}
    </details>
  </section>;
};

export const renderMonthlyCapacityUsage = (
  read: NorwayMonthlyCapacityRead, actions: MonthlyCapacityActionView = {},
): void => {
  const mount = document.getElementById('monthly-capacity-mount');
  if (!mount) return;
  mount.hidden = read.state === 'hidden';
  render(<MonthlyCapacityCard read={read} nowMs={Date.now()} {...actions} />, mount);
};
