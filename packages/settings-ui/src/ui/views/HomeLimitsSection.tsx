import { render } from 'preact';
import {
  composeHomeLimitsInactiveNotice,
  composeHomeLimitsSimulationNotice,
  HOME_LIMITS_CONTROL_HINT,
  HOME_LIMITS_CONTROL_LABEL,
  HOME_LIMITS_HARD_CAP_HINT,
  HOME_LIMITS_HARD_CAP_LABEL,
  HOME_LIMITS_MARGIN_LABEL,
  HOME_LIMITS_REACTION_LABEL,
  HOME_LIMITS_REACTION_NOTE,
  HOME_LIMITS_INACTIVE_CHIP,
  HOME_LIMITS_INACTIVE_STATUS,
  HOME_LIMITS_GLOBAL_SETTINGS_ELSEWHERE,
} from '../../../../shared-domain/src/homeLimitsCopy.ts';
import {
  composeHomeLimitsStateLine,
  formatHomeLimitsKw,
  HOME_LIMITS_STATUS_HARD_CAP_LABEL,
  HOME_LIMITS_STATUS_POWER_NOW_LABEL,
  HOME_LIMITS_STATUS_TITLE,
  resolveHomeLimitsPostureChip,
  type HomeLimitsStatus,
} from '../../../../shared-domain/src/homeLimitsStatus.ts';
import { composeHomeScopedTitle } from '../../../../shared-domain/src/homeScopeCopy.ts';
import { MdSwitch } from './materialWebJSX.tsx';

// Per-home "Limits & safety" surface (multi-home U3). Progressive disclosure:
// this surface renders nothing at all unless a meter area is the selected home
// scope, so a single-home user sees the unchanged static Main-home form and
// nothing else. Which home is selected is the shell's business, not this
// panel's — the picker lives in the global scope bar (`homeScope.ts`), and the
// Main home's editor is the static form below this mount, kept byte-identical.
//
// All data + callbacks arrive as props (views/AGENTS.md); native input wrapped
// in `.field`, md-switch per the Material interop pattern. Rendered into
// `#home-limits-mount` above the static form by the homeLimits controller.

/** md-switch exposes its state as a `.selected` property (Material Web interop). */
type SwitchElement = HTMLElement & { selected: boolean };

export type HomeLimitsEditorView = {
  /** The selected meter area's name — drives the simulation notice. */
  areaName: string;
  hardCapValue: string;
  marginValue: string;
  /** True = the area is only simulating (control OFF); the positive toggle is ON when false. */
  dryRun: boolean;
  /** False while a saved pre-GA config is deliberately held in Main home. */
  runtimeActive: boolean;
  /** True while a control-toggle write is in flight — disables the toggle (serialize). */
  controlBusy: boolean;
  /** Live margin-vs-cap alert (margin ≥ cap); null keeps the row quiet. */
  marginError: string | null;
  /** Computed "safe pace starts each hour at" figure ("6.0 kW" / placeholder). */
  reactionKw: string;
  /** Resolved status blob for the card; null while the first read is in flight. */
  status: HomeLimitsStatus | null;
  onHardCapInput: (value: string) => void;
  onHardCapChange: () => void;
  onMarginInput: (value: string) => void;
  onMarginChange: () => void;
  /** Positive toggle: `controlEnabled` true = PELS controls this area (dry-run off). */
  onControlToggle: (controlEnabled: boolean) => void;
};

export type HomeLimitsSectionProps = {
  /**
   * null ⇒ the Main home is the selected scope (the static form is its
   * editor), or the selected area's scalars are still being read. Non-null ⇒
   * render the meter-area editor.
   */
  editor: HomeLimitsEditorView | null;
};

const CapFields = ({ editor }: { editor: HomeLimitsEditorView }) => (
  <section class="settings-form-card home-limits__fields">
    <label class="field">
      <span class="field__label pels-text-settings-label">{HOME_LIMITS_HARD_CAP_LABEL}</span>
      <input
        id="home-limits-hard-cap"
        class="pels-input hy-nostyle"
        type="number"
        step="0.1"
        min="0"
        inputmode="decimal"
        autocomplete="off"
        value={editor.hardCapValue}
        onInput={(event: Event) => editor.onHardCapInput((event.currentTarget as HTMLInputElement).value)}
        onChange={() => editor.onHardCapChange()}
      />
      <small class="field__hint">{HOME_LIMITS_HARD_CAP_HINT}</small>
    </label>
    <label class="field">
      <span class="field__label pels-text-settings-label">{HOME_LIMITS_MARGIN_LABEL}</span>
      <input
        id="home-limits-margin"
        class="pels-input hy-nostyle"
        type="number"
        step="0.05"
        min="0"
        inputmode="decimal"
        autocomplete="off"
        value={editor.marginValue}
        onInput={(event: Event) => editor.onMarginInput((event.currentTarget as HTMLInputElement).value)}
        onChange={() => editor.onMarginChange()}
      />
      {editor.marginError !== null && (
        <small class="field__hint field__hint--alert" id="home-limits-margin-alert">{editor.marginError}</small>
      )}
    </label>
    <div class="settings-result" role="group" aria-labelledby="home-limits-reaction-label">
      <span class="settings-result__label" id="home-limits-reaction-label">{HOME_LIMITS_REACTION_LABEL}</span>
      <strong class="settings-result__value" id="home-limits-reaction">{editor.reactionKw}</strong>
      <span class="settings-result__note">{HOME_LIMITS_REACTION_NOTE}</span>
    </div>
  </section>
);

// Positive activation toggle: ON (green md-switch) = PELS controls/limits this
// meter area (dry-run off), matching the "Active" status chip; OFF = simulating.
// A held pre-GA config renders OFF + disabled regardless of its old dry-run
// value, because only an explicit save in Multiple meters activates that config.
// The switch is disabled while a write is in flight so a rapid second toggle
// can't race the first or be lost (the controller serialises the write).
const SimulationCard = ({ editor }: { editor: HomeLimitsEditorView }) => (
  <section class="settings-form-card home-limits__simulation">
    <label class="md-switch-row" id="home-limits-simulation-row">
      <MdSwitch
        id="home-limits-simulation-switch"
        aria-label={HOME_LIMITS_CONTROL_LABEL}
        {...(editor.runtimeActive && !editor.dryRun ? { selected: true } : {})}
        {...(editor.controlBusy || !editor.runtimeActive ? { disabled: true } : {})}
        onChange={(event: Event) => editor.onControlToggle((event.currentTarget as SwitchElement).selected)}
      />
      <span class="md-switch-row__content">
        <span class="md-switch-row__label pels-text-settings-label">{HOME_LIMITS_CONTROL_LABEL}</span>
        <small class="field__hint">{HOME_LIMITS_CONTROL_HINT}</small>
      </span>
    </label>
    {!editor.runtimeActive && (
      <div class="pels-notice-warning home-limits__sim-notice" id="home-limits-inactive-notice">
        {composeHomeLimitsInactiveNotice(editor.areaName)}
      </div>
    )}
    {editor.runtimeActive && editor.dryRun && (
      <div class="pels-notice-warning home-limits__sim-notice" id="home-limits-sim-notice">
        {composeHomeLimitsSimulationNotice(editor.areaName)}
      </div>
    )}
  </section>
);

// `Power now` is the canonical whole-home hero label. Reading it unqualified on
// a scoped page, next to an Overview that shows the same words for the whole
// house, is the confusion the scoped title prevents — so the card names its
// home too.
const StatusCard = ({ status, runtimeActive, areaName }: {
  status: HomeLimitsStatus;
  runtimeActive: boolean;
  areaName: string;
}) => {
  const chip = runtimeActive
    ? resolveHomeLimitsPostureChip(status)
    : { label: HOME_LIMITS_INACTIVE_CHIP, tone: 'warn' as const };
  const stateLineToneClass = runtimeActive
    && status.hasStatus && status.posture === 'active' && status.shortfall
    ? 'home-limits__status-line field__hint--alert'
    : 'home-limits__status-line muted';
  const stateLine = runtimeActive
    ? composeHomeLimitsStateLine(status)
    : HOME_LIMITS_INACTIVE_STATUS;
  return (
    <section class="settings-form-card home-limits__status" id="home-limits-status">
      <div class="home-limits__status-head">
        <h3 class="pels-text-card-title">{composeHomeScopedTitle(HOME_LIMITS_STATUS_TITLE, areaName)}</h3>
        <span class={`plan-chip plan-chip--${chip.tone}`} id="home-limits-status-chip">{chip.label}</span>
      </div>
      <div class="deadline-hero-stats">
        <div class="deadline-hero-stats__pair">
          <span class="deadline-hero-stats__label">{HOME_LIMITS_STATUS_POWER_NOW_LABEL}</span>
          <p class="deadline-hero-stats__value" id="home-limits-status-power">
            {formatHomeLimitsKw(runtimeActive ? status.powerNowKw : null)}
          </p>
        </div>
        <div class="deadline-hero-stats__pair">
          <span class="deadline-hero-stats__label">{HOME_LIMITS_STATUS_HARD_CAP_LABEL}</span>
          <p class="deadline-hero-stats__value" id="home-limits-status-cap">
            {formatHomeLimitsKw(status.hardCapKw)}
          </p>
        </div>
      </div>
      <small class={stateLineToneClass} id="home-limits-status-line">{stateLine}</small>
    </section>
  );
};

const HomeLimitsSectionView = ({ editor }: HomeLimitsSectionProps) => {
  if (editor === null) return null;
  return (
    <div class="home-limits">
      <CapFields editor={editor} />
      <SimulationCard editor={editor} />
      {editor.status !== null && (
        <StatusCard status={editor.status} runtimeActive={editor.runtimeActive} areaName={editor.areaName} />
      )}
      {/* Stands in for the app-global Power source / Whole-home meter card the
          controller hides in area scope, so those settings are accounted for
          rather than silently absent. Carded like every sibling: bare
          instructional prose at the foot of a card stack reads as leftover
          text rather than part of the page. */}
      <section class="settings-form-card home-limits__global-note">
        <p class="muted" id="home-limits-global-note">{HOME_LIMITS_GLOBAL_SETTINGS_ELSEWHERE}</p>
      </section>
    </div>
  );
};

export const renderHomeLimitsSection = (
  surface: HTMLElement,
  props: HomeLimitsSectionProps,
): void => {
  render(<HomeLimitsSectionView {...props} />, surface);
};
