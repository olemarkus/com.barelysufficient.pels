import { render } from 'preact';
import {
  composeHomeLimitsSimulationNotice,
  HOME_LIMITS_CONTROL_HINT,
  HOME_LIMITS_CONTROL_LABEL,
  HOME_LIMITS_HARD_CAP_HINT,
  HOME_LIMITS_HARD_CAP_LABEL,
  HOME_LIMITS_MARGIN_LABEL,
  HOME_LIMITS_REACTION_LABEL,
  HOME_LIMITS_REACTION_NOTE,
  HOME_LIMITS_SWITCHER_LABEL,
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
import { MdSwitch } from './materialWebJSX.tsx';

// Per-home "Limits & safety" surface (multi-home U3). Progressive disclosure:
// hidden entirely until at least one meter area exists, so a single-home user
// sees the unchanged static Main-home form and nothing else. When areas exist a
// home switcher appears; picking the Main home shows only the switcher (the
// static form below is the Main-home editor, kept byte-identical), while picking
// a meter area renders this Preact editor for that area's suffixed scalar keys.
//
// All data + callbacks arrive as props (views/AGENTS.md); native input/select
// wrapped in `.field`, md-switch per the Material interop pattern. Rendered into
// `#home-limits-mount` above the static form by the homeLimits controller.

/** md-switch exposes its state as a `.selected` property (Material Web interop). */
type SwitchElement = HTMLElement & { selected: boolean };

export type HomeLimitsHomeOption = { homeId: string; label: string };

export type HomeLimitsEditorView = {
  /** The selected meter area's name — drives the simulation notice. */
  areaName: string;
  hardCapValue: string;
  marginValue: string;
  /** True = the area is only simulating (control OFF); the positive toggle is ON when false. */
  dryRun: boolean;
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
  /** False until at least one meter area exists — then the whole surface hides. */
  visible: boolean;
  /** Main home first, then each meter area. */
  homeOptions: HomeLimitsHomeOption[];
  selectedHomeId: string;
  onSelectHome: (homeId: string) => void;
  /** null ⇒ Main home selected (the static form is the editor); else the area editor. */
  editor: HomeLimitsEditorView | null;
};

const HomeSwitcher = ({ homeOptions, selectedHomeId, onSelectHome }: {
  homeOptions: HomeLimitsHomeOption[];
  selectedHomeId: string;
  onSelectHome: (homeId: string) => void;
}) => (
  <label class="field settings-form-card home-limits__switcher">
    <span class="field__label pels-text-settings-label">{HOME_LIMITS_SWITCHER_LABEL}</span>
    <select
      id="home-limits-home-select"
      class="pels-select hy-nostyle"
      value={selectedHomeId}
      onChange={(event: Event) => onSelectHome((event.currentTarget as HTMLSelectElement).value)}
    >
      {homeOptions.map((option) => (
        <option key={option.homeId} value={option.homeId}>{option.label}</option>
      ))}
    </select>
  </label>
);

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
// The switch is disabled while a write is in flight so a rapid second toggle
// can't race the first or be lost (the controller serialises the write). The
// honest activation notice shows only while OFF (simulating).
const SimulationCard = ({ editor }: { editor: HomeLimitsEditorView }) => (
  <section class="settings-form-card home-limits__simulation">
    <label class="md-switch-row" id="home-limits-simulation-row">
      <MdSwitch
        id="home-limits-simulation-switch"
        aria-label={HOME_LIMITS_CONTROL_LABEL}
        {...(editor.dryRun ? {} : { selected: true })}
        {...(editor.controlBusy ? { disabled: true } : {})}
        onChange={(event: Event) => editor.onControlToggle((event.currentTarget as SwitchElement).selected)}
      />
      <span class="md-switch-row__content">
        <span class="md-switch-row__label pels-text-settings-label">{HOME_LIMITS_CONTROL_LABEL}</span>
        <small class="field__hint">{HOME_LIMITS_CONTROL_HINT}</small>
      </span>
    </label>
    {editor.dryRun && (
      <div class="pels-notice-warning home-limits__sim-notice" id="home-limits-sim-notice">
        {composeHomeLimitsSimulationNotice(editor.areaName)}
      </div>
    )}
  </section>
);

const StatusCard = ({ status }: { status: HomeLimitsStatus }) => {
  const chip = resolveHomeLimitsPostureChip(status);
  const stateLineToneClass = status.hasStatus && status.posture === 'active' && status.shortfall
    ? 'home-limits__status-line field__hint--alert'
    : 'home-limits__status-line muted';
  return (
    <section class="settings-form-card home-limits__status" id="home-limits-status">
      <div class="home-limits__status-head">
        <h3 class="pels-text-card-title">{HOME_LIMITS_STATUS_TITLE}</h3>
        <span class={`plan-chip plan-chip--${chip.tone}`} id="home-limits-status-chip">{chip.label}</span>
      </div>
      <div class="deadline-hero-stats">
        <div class="deadline-hero-stats__pair">
          <span class="deadline-hero-stats__label">{HOME_LIMITS_STATUS_POWER_NOW_LABEL}</span>
          <p class="deadline-hero-stats__value" id="home-limits-status-power">
            {formatHomeLimitsKw(status.powerNowKw)}
          </p>
        </div>
        <div class="deadline-hero-stats__pair">
          <span class="deadline-hero-stats__label">{HOME_LIMITS_STATUS_HARD_CAP_LABEL}</span>
          <p class="deadline-hero-stats__value" id="home-limits-status-cap">
            {formatHomeLimitsKw(status.hardCapKw)}
          </p>
        </div>
      </div>
      <small class={stateLineToneClass} id="home-limits-status-line">{composeHomeLimitsStateLine(status)}</small>
    </section>
  );
};

const HomeLimitsSectionView = (props: HomeLimitsSectionProps) => {
  if (!props.visible) return null;
  return (
    <div class="home-limits">
      <HomeSwitcher
        homeOptions={props.homeOptions}
        selectedHomeId={props.selectedHomeId}
        onSelectHome={props.onSelectHome}
      />
      {props.editor !== null && (
        <>
          <CapFields editor={props.editor} />
          <SimulationCard editor={props.editor} />
          {props.editor.status !== null && <StatusCard status={props.editor.status} />}
        </>
      )}
    </div>
  );
};

export const renderHomeLimitsSection = (
  surface: HTMLElement,
  props: HomeLimitsSectionProps,
): void => {
  render(<HomeLimitsSectionView {...props} />, surface);
};
