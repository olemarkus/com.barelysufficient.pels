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
import type { OverviewDeviceRow } from '../overviewDeviceRows.ts';
import { DEVICE_OVERVIEW_AWAITING_FIRST_READING } from '../../../../shared-domain/src/deviceOverviewStrings.ts';
import type {
  SettingsUiPricesPayload,
} from '../../../../contracts/src/settingsUiApi.ts';
import type { SolarNowInput } from '../../../../shared-domain/src/solar/solarNow.ts';

type OverviewProps = {
  // One row per device PELS manages, from the DEVICE list joined to this
  // cycle's plan (`buildOverviewDeviceRows`). The device list is the list: a
  // row can be `undecided`, which is a device without a decision rather than a
  // missing device.
  rows: readonly OverviewDeviceRow[];
  // True once the DEVICE payload has been delivered. The empty state is a
  // device-list verdict now, so it must wait for the device list — otherwise a
  // session that opens on the Overview renders "No managed devices" for the
  // moment before the first `/ui_devices` response.
  devicesResolved: boolean;
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
  dev.temperature !== undefined
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

/**
 * A device PELS manages but has not decided anything for this cycle.
 *
 * Renders the device rather than a gap. Before this existed the whole surface
 * went blank whenever the plan was missing, so a missing CONTROL artefact was
 * indistinguishable from having no devices at all.
 *
 * It deliberately shows no state chip and no reason line: there is no decision
 * to describe, and a placeholder one would be a decision the planner never made.
 */
const PlanUndecidedCard = ({ name }: { name: string }) => (
  <section class="pels-surface-card plan-card plan-card--undecided">
    <MdElevation aria-hidden="true" />
    <p class="plan-card__title">{name}</p>
    <p class="pels-card-supporting">{DEVICE_OVERVIEW_AWAITING_FIRST_READING}</p>
  </section>
);

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
  rows, devicesResolved, plan, planResolved, scopeUnavailable, prices, solarNowInput, smartTaskRow, context, renderedAtMs, nowMs,
}: OverviewProps) => {
  if (scopeUnavailable) {
    return <div><ScopeUnavailableNotice /></div>;
  }

  // The empty state is now a DEVICE-list question, not a plan question. It used
  // to be both: with no plan the surface said "No plan available yet" and drew
  // no cards, so an owner with ten managed devices and no power reading saw the
  // same blank page as an owner with none. The cards come from the device list,
  // so a missing plan costs the DECISIONS, not the devices.
  //
  // `planResolved` still gates it. Before the first payload has been delivered
  // the surface is loading, and an empty-state verdict then would be a guess.
  const emptyMessage = planResolved && devicesResolved && rows.length === 0
    // No "yet" — a returning user who unmanages their last device reaches
    // this state too (notes/ui-terminology.md, empty-state headline rule).
    ? 'No managed devices. Pick the devices PELS may manage.'
    : null;

  return (
    <div>
      <PlanHero
        plan={plan}
        prices={prices}
        solarNowInput={solarNowInput}
        context={context}
        renderedAtMs={renderedAtMs}
        nowMs={nowMs}
      />
      <div id="plan-hour-strip" class="plan-hour-strip" hidden />
      {smartTaskRow !== null && <SmartTaskRow row={smartTaskRow} />}
      {emptyMessage && (
        // Same carded "empty → go configure" treatment as the Price-aware
        // devices zero state; on-surface text, not .muted — this line is the
        // page's primary instruction when nothing is managed. There is only one
        // empty state now: with the cards sourced from the device list, "no
        // devices" is the only way this surface can be empty, and it always has
        // the same next step.
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
        {rows.map((row) => (
          row.kind === 'decided' ? (
            <PlanCard
              key={row.device.id}
              dev={row.plan}
              plan={plan}
              dryRun={context.dryRun}
              renderedAtMs={renderedAtMs}
              nowMs={nowMs}
            />
          ) : (
            <PlanUndecidedCard key={row.device.id} name={row.device.name} />
          )
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
