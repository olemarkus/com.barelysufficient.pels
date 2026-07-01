import { render } from 'preact';
import { PlanHero, type HeroContext } from './PlanHero.tsx';
import { PlanSteppedCard } from './PlanSteppedCard.tsx';
import { PlanGenericCard, PlanTemperatureCard } from './PlanDeviceCards.tsx';
import type { PlanDeviceSnapshot, PlanSnapshot } from '../planTypes.ts';
import type {
  SettingsUiPowerStatus,
  SettingsUiPricesPayload,
} from '../../../../contracts/src/settingsUiApi.ts';

type OverviewProps = {
  plan: PlanSnapshot | null;
  // True once a plan payload has been delivered (even a null one). While
  // false the overview is still loading: keep showing the hero skeleton and
  // suppress the "No plan available yet" empty state, which would otherwise
  // flash as a premature verdict during a slow boot.
  planResolved: boolean;
  power: SettingsUiPowerStatus | null;
  prices: SettingsUiPricesPayload | null;
  context: HeroContext;
  renderedAtMs: number;
  nowMs: number;
};

const isTemperatureCard = (dev: PlanDeviceSnapshot): boolean => (
  dev.controlModel === 'temperature_target'
  || typeof dev.plannedTarget === 'number'
);

const PlanCard = ({
  dev,
  plan,
  renderedAtMs,
  nowMs,
}: {
  dev: PlanDeviceSnapshot;
  plan: PlanSnapshot | null;
  renderedAtMs: number;
  nowMs: number;
}) => {
  if (dev.controlModel === 'stepped_load') {
    return <PlanSteppedCard dev={dev} plan={plan} renderedAtMs={renderedAtMs} nowMs={nowMs} />;
  }
  if (isTemperatureCard(dev)) {
    return <PlanTemperatureCard dev={dev} plan={plan} renderedAtMs={renderedAtMs} nowMs={nowMs} />;
  }
  return <PlanGenericCard dev={dev} plan={plan} renderedAtMs={renderedAtMs} nowMs={nowMs} />;
};

const PlanOverviewRoot = ({ plan, planResolved, power, prices, context, renderedAtMs, nowMs }: OverviewProps) => {
  const devices = plan
    ? [...(plan.devices ?? [])].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    : [];

  let emptyMessage: string | null = null;
  if (plan === null) {
    if (planResolved) emptyMessage = 'No plan available yet. Send power data or refresh devices.';
  } else if (devices.length === 0) emptyMessage = 'No managed devices.';

  return (
    <div>
      <PlanHero plan={plan} power={power} prices={prices} context={context} renderedAtMs={renderedAtMs} nowMs={nowMs} />
      <div id="plan-hour-strip" class="plan-hour-strip" hidden />
      {emptyMessage && <p id="plan-empty" class="muted">{emptyMessage}</p>}
      <div id="plan-cards" class="plan-cards">
        {devices.map((dev) => (
          <PlanCard
            key={dev.id}
            dev={dev}
            plan={plan}
            renderedAtMs={renderedAtMs}
            nowMs={nowMs}
          />
        ))}
      </div>
    </div>
  );
};

// ─── Mount and render ─────────────────────────────────────────────────────────

// NOTE: the caller must hand over an EMPTY (or Preact-managed) surface. The
// static `#plan-redesign-surface` markup in index.html ships a first-paint
// skeleton; Preact's first render into a non-empty container tries to ADOPT
// those static nodes as its own tree and strands the leftovers (`#plan-cards`
// + `data-overview-cards-placeholder`) as ghost cards below the real device
// list. `planRedesign.ts` clears the skeleton once before the first render.
export const renderPlanOverview = (surface: HTMLElement, props: OverviewProps): void => {
  render(<PlanOverviewRoot {...props} />, surface);
};
