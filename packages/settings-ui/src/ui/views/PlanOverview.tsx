import { render } from 'preact';
import { MdElevation, MdOutlinedButton, MdRipple } from './materialWebJSX.tsx';
import { PlanHero, type HeroContext } from './PlanHero.tsx';
import {
  HOME_SCOPE_OVERVIEW_UNAVAILABLE_BODY,
  HOME_SCOPE_OVERVIEW_UNAVAILABLE_HEADLINE,
} from '../../../../shared-domain/src/homeScopeCopy.ts';
import {
  formatOverviewSmartTaskRowLine,
  type OverviewSmartTaskRow,
} from '../../../../shared-domain/src/overviewSmartTaskRow.ts';
import { PlanSteppedCard } from './PlanSteppedCard.tsx';
import { PlanGenericCard, PlanTemperatureCard } from './PlanDeviceCards.tsx';
import type { PlanDeviceSnapshot, PlanSnapshot } from '../planTypes.ts';
import type {
  SettingsUiPowerStatus,
  SettingsUiPricesPayload,
} from '../../../../contracts/src/settingsUiApi.ts';
import type { SolarNowInput } from '../../../../shared-domain/src/solar/solarNow.ts';

type OverviewProps = {
  plan: PlanSnapshot | null;
  // True once a plan payload has been delivered (even a null one). While
  // false the overview is still loading: keep showing the hero skeleton and
  // suppress the "No plan available yet" empty state, which would otherwise
  // flash as a premature verdict during a slow boot.
  planResolved: boolean;
  // True when the selected part of the home answered `homeScope: unavailable`
  // (multi-home): the honest notice replaces the hero and cards — the flat
  // payload is the empty shape, and rendering it would fabricate a `0.0 kW`
  // reading nobody took.
  scopeUnavailable: boolean;
  power: SettingsUiPowerStatus | null;
  prices: SettingsUiPricesPayload | null;
  solarNowInput: SolarNowInput | null;
  // The one smart-task failure/readiness row below the hero (null renders
  // nothing — no active tasks and no recent misses). Resolved in the
  // orchestrator (`planRedesign.ts`) so this view stays props-in.
  smartTaskRow: OverviewSmartTaskRow | null;
  context: HeroContext;
  renderedAtMs: number;
  nowMs: number;
};

// One slim tappable pointer row: tap → the Smart tasks tab (the shell's
// `[data-settings-target]` delegate in boot.ts routes it — same mechanism as
// the Settings-hub cross-links). Exception-first ladder + copy live in
// `shared-domain/overviewSmartTaskRow.ts`; the device name may ellipsize at
// 320 px but the status text never truncates.
const SmartTaskRow = ({ row }: { row: OverviewSmartTaskRow }) => (
  <button
    type="button"
    id="plan-smart-task-row"
    class="pels-surface-card plan-smart-task-row clickable hy-nostyle"
    data-settings-target="deadlines"
    data-variant={row.variant}
    data-tone={row.tone}
    data-interactive
    aria-label={`${formatOverviewSmartTaskRowLine(row)} — open Smart tasks`}
  >
    <MdElevation aria-hidden="true" />
    <MdRipple aria-hidden="true" />
    <span class="plan-smart-task-row__dot" aria-hidden="true" />
    <span class="plan-smart-task-row__text">
      {row.deviceName !== null && (
        <span class="plan-smart-task-row__device">{row.deviceName}</span>
      )}
      <span class="plan-smart-task-row__status">
        {row.deviceName !== null ? ` — ${row.statusText}` : row.statusText}
      </span>
    </span>
    <span class="plan-smart-task-row__chevron" aria-hidden="true">›</span>
  </button>
);

// The retired `controlModel === 'temperature_target'` arm is gone, not lost:
// the producer derived that value FROM `deviceType === 'temperature'`
// (`resolveDefaultControlModel`), so for a non-stepped device the two arms were
// the same question asked twice.
const isTemperatureCard = (dev: PlanDeviceSnapshot): boolean => (
  dev.deviceType === 'temperature'
  || typeof dev.plannedTarget === 'number'
);

const PlanCard = ({
  dev,
  plan,
  dryRun,
  renderedAtMs,
  nowMs,
}: {
  dev: PlanDeviceSnapshot;
  plan: PlanSnapshot | null;
  dryRun: boolean;
  renderedAtMs: number;
  nowMs: number;
}) => {
  // Card selection keys on the producer's own stepped cluster. It used to read
  // a reconstructed `controlModel`, and the reconstruction consulted a
  // raw-snapshot map that cannot see a STORED step ladder — so a device the
  // owner had configured as a stepped load rendered as a generic card.
  if (dev.steppedLoad !== undefined) {
    return <PlanSteppedCard dev={dev} plan={plan} dryRun={dryRun} renderedAtMs={renderedAtMs} nowMs={nowMs} />;
  }
  if (isTemperatureCard(dev)) {
    return <PlanTemperatureCard dev={dev} plan={plan} dryRun={dryRun} renderedAtMs={renderedAtMs} nowMs={nowMs} />;
  }
  return <PlanGenericCard dev={dev} plan={plan} dryRun={dryRun} renderedAtMs={renderedAtMs} nowMs={nowMs} />;
};

// Honest per-home state (multi-home), the Usage tab's `#usage-scope-unavailable`
// contract on the Preact surface: one notice card INSTEAD of the data sections.
// Copy comes from shared-domain (`homeScopeCopy.ts`) so the words can never
// drift from the Usage notice's or a future runtime log line's.
const ScopeUnavailableNotice = () => (
  <section
    class="pels-surface-card plan-scope-unavailable"
    id="plan-scope-unavailable"
    aria-live="polite"
  >
    <MdElevation aria-hidden="true" />
    <p class="plan-card__title">{HOME_SCOPE_OVERVIEW_UNAVAILABLE_HEADLINE}</p>
    <p class="pels-card-supporting">{HOME_SCOPE_OVERVIEW_UNAVAILABLE_BODY}</p>
  </section>
);

const PlanOverviewRoot = ({
  plan, planResolved, scopeUnavailable, power, prices, solarNowInput, smartTaskRow, context, renderedAtMs, nowMs,
}: OverviewProps) => {
  if (scopeUnavailable) {
    return <div><ScopeUnavailableNotice /></div>;
  }
  const devices = plan
    ? [...(plan.devices ?? [])].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    : [];

  let emptyMessage: string | null = null;
  let showManageDevicesLink = false;
  if (plan === null) {
    // The global no-power-data banner (with its power-source link) explains
    // how to get data flowing; this line only states what the blank means.
    if (planResolved) emptyMessage = 'No plan available yet. PELS builds one after the first power reading.';
  } else if (devices.length === 0) {
    // No "yet" — a returning user who unmanages their last device reaches
    // this state too (notes/ui-terminology.md, empty-state headline rule).
    emptyMessage = 'No managed devices. Pick the devices PELS may manage.';
    showManageDevicesLink = true;
  }

  return (
    <div>
      <PlanHero
        plan={plan}
        power={power}
        prices={prices}
        solarNowInput={solarNowInput}
        context={context}
        renderedAtMs={renderedAtMs}
        nowMs={nowMs}
      />
      <div id="plan-hour-strip" class="plan-hour-strip" hidden />
      {smartTaskRow !== null && <SmartTaskRow row={smartTaskRow} />}
      {emptyMessage && !showManageDevicesLink && <p id="plan-empty" class="muted">{emptyMessage}</p>}
      {emptyMessage && showManageDevicesLink && (
        // Same carded "empty → go configure" treatment as the Price-aware
        // devices zero state; on-surface text, not .muted — this line is the
        // page's primary instruction when nothing is managed.
        <div class="settings-form-card">
          <p id="plan-empty">{emptyMessage}</p>
          <div class="form__actions">
            <MdOutlinedButton type="button" id="plan-empty-manage-devices" data-settings-target="devices">
              Choose devices
            </MdOutlinedButton>
          </div>
        </div>
      )}
      <div id="plan-cards" class="plan-cards">
        {devices.map((dev) => (
          <PlanCard
            key={dev.id}
            dev={dev}
            plan={plan}
            dryRun={context.dryRun}
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
