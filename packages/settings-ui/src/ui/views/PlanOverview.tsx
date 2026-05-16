import { render } from 'preact';
import { PlanHero, type HeroContext } from './PlanHero.tsx';
import { PlanSteppedCard } from './PlanSteppedCard.tsx';
import { PlanGenericCard, PlanTemperatureCard } from './PlanDeviceCards.tsx';
import type { PlanDeviceSnapshot, PlanSnapshot } from '../planTypes.ts';
import type { SettingsUiPowerStatus } from '../../../../contracts/src/settingsUiApi.ts';

type OverviewProps = {
  plan: PlanSnapshot | null;
  power: SettingsUiPowerStatus | null;
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
  rank,
  renderedAtMs,
  nowMs,
}: {
  dev: PlanDeviceSnapshot;
  plan: PlanSnapshot | null;
  rank: number | null;
  renderedAtMs: number;
  nowMs: number;
}) => {
  if (dev.controlModel === 'stepped_load') {
    return <PlanSteppedCard dev={dev} plan={plan} rank={rank} renderedAtMs={renderedAtMs} nowMs={nowMs} />;
  }
  if (isTemperatureCard(dev)) {
    return <PlanTemperatureCard dev={dev} plan={plan} rank={rank} renderedAtMs={renderedAtMs} nowMs={nowMs} />;
  }
  return <PlanGenericCard dev={dev} plan={plan} rank={rank} renderedAtMs={renderedAtMs} nowMs={nowMs} />;
};

const PlanOverviewRoot = ({ plan, power, context, renderedAtMs, nowMs }: OverviewProps) => {
  const devices = plan
    ? [...(plan.devices ?? [])].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    : [];

  let emptyMessage: string | null = null;
  if (plan === null) emptyMessage = 'No plan available yet. Send power data or refresh devices.';
  else if (devices.length === 0) emptyMessage = 'No managed devices.';

  return (
    <div>
      <PlanHero plan={plan} power={power} context={context} renderedAtMs={renderedAtMs} nowMs={nowMs} />
      <div id="plan-hour-strip" class="plan-hour-strip" hidden />
      {emptyMessage && <p id="plan-empty" class="muted">{emptyMessage}</p>}
      <div id="plan-cards" class="plan-cards">
        {devices.map((dev, index) => (
          <PlanCard
            key={dev.id}
            dev={dev}
            plan={plan}
            rank={typeof dev.priority === 'number' ? index + 1 : null}
            renderedAtMs={renderedAtMs}
            nowMs={nowMs}
          />
        ))}
      </div>
    </div>
  );
};

// ─── Mount and render ─────────────────────────────────────────────────────────

export const renderPlanOverview = (surface: HTMLElement, props: OverviewProps): void => {
  render(<PlanOverviewRoot {...props} />, surface);
};
