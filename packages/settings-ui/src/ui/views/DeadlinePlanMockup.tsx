import { render } from 'preact';

type DeadlinePlanChipTone = 'info' | 'muted' | 'ok' | 'warn';
type DeadlinePlanHourTone = 'cheap' | 'expensive' | 'normal';

type DeadlinePlanChip = {
  text: string;
  tone: DeadlinePlanChipTone;
};

type DeadlinePlanHour = {
  time: string;
  price: string;
  priceLevel?: number;
  tone: DeadlinePlanHourTone;
  plan?: 'Charge' | 'Fallback';
  usage?: {
    otherKwh: number;
    chargerKwh: number;
    hardCapKwh: number;
  };
  progress?: number;
};

export type DeadlinePlanMockupPayload = {
  hero: {
    chips: DeadlinePlanChip[];
    sectionLabel: string;
    headline: string;
    subline: string;
    decision: string;
  };
  timeline: {
    title: string;
    subtitle: string;
    ariaLabel: string;
    hours: DeadlinePlanHour[];
    explainer: string;
  };
};

export type DeadlinePlanMockupLoadState =
  | { status: 'error'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; payload: DeadlinePlanMockupPayload };

const chipClass = (tone: DeadlinePlanChipTone): string => `plan-chip plan-chip--${tone}`;

const isHorizonMajorTick = (index: number, hourCount: number): boolean => (
  (index % 6 === 0 && index < hourCount - 2) || index === hourCount - 1
);

const clampPct = (value: number): number => Math.max(0, Math.min(100, value));

const kwhToPct = (value: number, hardCapKwh: number): number => (
  clampPct((Math.max(0, value) / Math.max(0.1, hardCapKwh)) * 100)
);

const DeadlineHero = ({ payload }: { payload: DeadlinePlanMockupPayload }) => (
  <section class="plan-hero" data-tone="ok" aria-labelledby="deadline-plan-title">
    <div class="plan-hero__chips">
      {payload.hero.chips.map((chip) => (
        <span key={chip.text} class={chipClass(chip.tone)}>{chip.text}</span>
      ))}
    </div>
    <div class="plan-hero__section">
      <span class="plan-hero__section-label" id="deadline-plan-title">{payload.hero.sectionLabel}</span>
      <div class="plan-hero__headline">{payload.hero.headline}</div>
      <div class="plan-hero__subline">{payload.hero.subline}</div>
      <p class="plan-hero__decision" data-positive>{payload.hero.decision}</p>
    </div>
  </section>
);

const HorizonLegend = () => (
  <div class="budget-chart-legend deadline-horizon-legend">
    <span class="budget-chart-legend__item"><i class="deadline-plan-mark deadline-plan-mark--charge" aria-hidden="true" />Charging</span>
    <span class="budget-chart-legend__item"><i class="deadline-plan-mark deadline-plan-mark--fallback" aria-hidden="true" />Fallback</span>
    <span class="budget-chart-legend__item"><i class="deadline-plan-mark deadline-plan-mark--other-load" aria-hidden="true" />Other load</span>
    <span class="budget-chart-legend__item"><i class="deadline-plan-mark deadline-plan-mark--charger" aria-hidden="true" />Charger</span>
  </div>
);

const HorizonCard = ({ payload }: { payload: DeadlinePlanMockupPayload }) => {
  const hourCount = payload.timeline.hours.length;
  const gridStyle = {
    gridTemplateColumns: `repeat(${hourCount}, minmax(0, 1fr))`,
  };

  return (
    <section class="pels-surface-card budget-redesign-card deadline-horizon-card" aria-labelledby="deadline-horizon-title">
      <div class="budget-card-header">
        <div>
          <h2 class="plan-card__title" id="deadline-horizon-title">Known-price horizon</h2>
          <p class="pels-card-supporting">{payload.timeline.subtitle}</p>
        </div>
      </div>

      <HorizonLegend />

      <div class="deadline-horizon" role="group" aria-label={payload.timeline.ariaLabel}>
        <div class="deadline-horizon__row">
          <span class="deadline-horizon__row-label">Price</span>
          <div class="deadline-horizon__grid" style={gridStyle}>
            {payload.timeline.hours.map((hour, index) => (
              <span
                key={`price-${hour.time}-${index}`}
                class={`deadline-horizon-price deadline-horizon-price--${hour.tone}`}
                style={{ '--price-height': `${12 + (hour.priceLevel ?? 40) * 0.4}px` }}
                data-major={isHorizonMajorTick(index, hourCount) ? 'true' : undefined}
              >
                {hour.time}
              </span>
            ))}
          </div>
        </div>
        <div class="deadline-horizon__row">
          <span class="deadline-horizon__row-label">Planned load</span>
          <div class="deadline-horizon__grid" style={gridStyle}>
            {payload.timeline.hours.map((hour, index) => {
              const usage = hour.usage ?? { otherKwh: 0, chargerKwh: 0, hardCapKwh: 1 };
              const otherLoad = kwhToPct(usage.otherKwh, usage.hardCapKwh);
              const chargerLoad = Math.min(
                kwhToPct(usage.chargerKwh, usage.hardCapKwh),
                100 - otherLoad,
              );
              return (
                <span
                  key={`usage-${hour.time}-${index}`}
                  class="deadline-load-bar"
                  style={{
                    '--other-load-height': `${otherLoad}%`,
                    '--device-load-height': `${chargerLoad}%`,
                  }}
                >
                  <span class="deadline-load-bar__other" />
                  <span class="deadline-load-bar__device" />
                </span>
              );
            })}
          </div>
        </div>
        <div class="deadline-horizon__row">
          <span class="deadline-horizon__row-label">Charging plan</span>
          <div class="deadline-horizon__grid" style={gridStyle}>
            {payload.timeline.hours.map((hour, index) => (
              <span
                key={`plan-${hour.time}-${index}`}
                class={`deadline-horizon-plan${hour.plan ? ` deadline-horizon-plan--${hour.plan.toLowerCase()}` : ''}`}
              />
            ))}
          </div>
        </div>
        <div class="deadline-horizon__row">
          <span class="deadline-horizon__row-label">Target progress</span>
          <div class="deadline-horizon__grid deadline-horizon__grid--progress" style={gridStyle}>
            {payload.timeline.hours.map((hour, index) => (
              <span
                key={`progress-${hour.time}-${index}`}
                class="deadline-progress-step"
              >
                <span class="deadline-progress-step__line" style={{ bottom: `${hour.progress ?? 0}%` }} />
                {index > 0 && payload.timeline.hours[index - 1]?.progress !== hour.progress && (
                  <span
                    class="deadline-progress-step__rise"
                    style={{
                      bottom: `${Math.min(payload.timeline.hours[index - 1]?.progress ?? 0, hour.progress ?? 0)}%`,
                      height: `${Math.abs((hour.progress ?? 0) - (payload.timeline.hours[index - 1]?.progress ?? 0))}%`,
                    }}
                  />
                )}
              </span>
            ))}
          </div>
        </div>
        <div class="deadline-horizon__axis" style={gridStyle} aria-hidden="true">
          {payload.timeline.hours.map((hour, index) => (
            <span
              key={`axis-${hour.time}-${index}`}
              data-major={isHorizonMajorTick(index, hourCount) ? 'true' : undefined}
            >
              {hour.time}
            </span>
          ))}
        </div>
      </div>

      <p class="pels-card-supporting budget-chart-caveat">{payload.timeline.explainer}</p>
    </section>
  );
};

const DeadlinePlanMockupRoot = ({ loadState }: { loadState: DeadlinePlanMockupLoadState }) => {
  if (loadState.status === 'loading') {
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">Loading deadline plan</h1>
        <p class="pels-card-supporting">Preparing the device plan.</p>
      </section>
    );
  }

  if (loadState.status === 'error') {
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">Deadline plan unavailable</h1>
        <p class="pels-card-supporting">{loadState.message}</p>
      </section>
    );
  }

  return (
    <>
      <DeadlineHero payload={loadState.payload} />
      <HorizonCard payload={loadState.payload} />
    </>
  );
};

export const renderDeadlinePlanMockup = (
  surface: HTMLElement,
  loadState: DeadlinePlanMockupLoadState,
): void => {
  render(<DeadlinePlanMockupRoot loadState={loadState} />, surface);
};
