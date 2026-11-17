import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { PriceOptDevice } from '../priceConfigTypes.ts';
import { MdDialog, MdIconButton, MdOutlinedButton, MdSwitch, MdTextButton } from './materialWebJSX.tsx';
import { AppBar } from './AppBar.tsx';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import {
  MAX_PRICE_ADJUSTMENT_C,
  type PriceAdjustmentKind,
} from '../../../../shared-domain/src/settings/priceOptimization.ts';
import type { PriceSetupStatus } from '../priceSetupStatus.ts';

/** The page's callbacks into its controller (`priceConfig.ts`), one per control. */
export type PriceAwareDevicesHandlers = {
  onOptimizationToggle: (enabled: boolean) => void;
  onOptimizationOffConfirm: () => void;
  onOptimizationOffDismiss: () => void;
  onDevicePriceAdjustmentChange: (id: string, kind: PriceAdjustmentKind, sizeC: number) => void;
};

export type PriceAwareDevicesViewProps = {
  /** The prices these devices respond to, so turning them on never hides an unset source. */
  priceSetupStatus: PriceSetupStatus;
  optimizationEnabled: boolean;
  optimizationBusy: boolean;
  optimizationOffArmed: boolean;
  devices: PriceOptDevice[];
  handlers: PriceAwareDevicesHandlers;
};

const DELTA_MIN = 0;
const DELTA_MAX = MAX_PRICE_ADJUSTMENT_C;
const DELTA_STEP = 0.5;

const clamp = (val: number, min: number, max: number): number => Math.min(max, Math.max(min, val));

const formatMagnitude = (val: number): string => {
  const rounded = Math.round(val * 10) / 10;
  const isWhole = Math.abs(rounded - Math.round(rounded)) < 0.01;
  return isWhole ? rounded.toString() : rounded.toFixed(1);
};

type ValueAdjusterProps = {
  direction: 'up' | 'down';
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  increaseLabel: string;
  decreaseLabel: string;
  onChange: (value: number) => void;
};

type SwitchElement = HTMLElement & { selected: boolean };

const ValueAdjuster = ({
  direction,
  value,
  min,
  max,
  step,
  unit,
  disabled,
  increaseLabel,
  decreaseLabel,
  onChange,
}: ValueAdjusterProps) => {
  const arrow = direction === 'up' ? '↑' : '↓';
  const magnitude = formatMagnitude(value);
  const display = value === 0 ? `0${unit ? ` ${unit}` : ''}` : `${arrow}${magnitude}${unit ? ` ${unit}` : ''}`;

  const handleStep = (delta: number) => {
    if (disabled) return;
    const next = clamp(Math.round((value + delta) / step) * step, min, max);
    if (next !== value) onChange(next);
  };

  const handleKey = (e: KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      handleStep(step);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      handleStep(-step);
    }
  };

  return (
    <div class={`value-adjuster value-adjuster--${direction}`} role="group">
      <MdIconButton
        class="value-adjuster__btn"
        aria-label={decreaseLabel}
        {...(disabled || value <= min ? { disabled: true } : {})}
        onClick={() => handleStep(-step)}
        onKeyDown={handleKey}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <path d="M5 12h14" />
        </svg>
      </MdIconButton>
      <output
        class="value-adjuster__value"
        tabindex={0}
        aria-live="polite"
        onKeyDown={handleKey}
      >
        {display}
      </output>
      <MdIconButton
        class="value-adjuster__btn"
        aria-label={increaseLabel}
        {...(disabled || value >= max ? { disabled: true } : {})}
        onClick={() => handleStep(step)}
        onKeyDown={handleKey}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </MdIconButton>
    </div>
  );
};

const Header = () => (
  <AppBar
    back={{ target: 'settings', label: 'Back to Settings' }}
    title="Price-aware devices"
    lede="Boost when power is cheap, ease off when it is expensive, for eligible temperature devices."
  />
);

/**
 * Where the prices these devices respond to come from. Configuration only,
 * never a price: the price itself has its surfaces elsewhere.
 */
const PriceSourceCard = ({ status }: { status: PriceSetupStatus }) => {
  if (status.state === 'unavailable') return null;
  const open = status.state === 'open';
  return (
    <section class="settings-form-card" id="price-aware-devices-source">
      <div class="price-config-status-row">
        <h3 class="pels-text-card-title">Prices from</h3>
        {open && <span class="plan-chip plan-chip--warn">Not set up</span>}
      </div>
      <p class="pels-card-supporting">{status.summary}</p>
      <div class="form__actions">
        <MdOutlinedButton
          type="button"
          data-settings-target="electricity-prices"
          data-settings-anchor="#price-source-select"
        >
          {open ? 'Set up prices' : 'Change'}
        </MdOutlinedButton>
      </div>
    </section>
  );
};

const RespondTogglesCard = ({
  optimizationEnabled: enabled,
  optimizationBusy: busy,
  optimizationOffArmed: offArmed,
  handlers,
}: PriceAwareDevicesViewProps) => {
  const nativeInput = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    // Once interacted with, the checkbox follows its checked property rather
    // than the attribute Material renders from selected.
    if (nativeInput.current) nativeInput.current.checked = enabled;
  }, [enabled]);
  return (
  <>
    <label class="md-switch-row settings-form-card">
      <MdSwitch
        aria-label="Respond to prices"
        aria-describedby="respond-to-prices-hint"
        selected={enabled}
        disabled={busy || offArmed}
        onInput={(event) => {
          const element = event.currentTarget as SwitchElement;
          // Material's input event is composed, so its native checkbox is the
          // source. Restore both states: resetting only selected before Lit
          // renders leaves the checkbox toggled and breaks the next request.
          const source = event.composedPath()[0];
          if (!(source instanceof HTMLInputElement)) return;
          nativeInput.current = source;
          const next = source.checked;
          source.checked = enabled;
          element.selected = enabled;
          handlers.onOptimizationToggle(next);
        }}
      />
      <span class="md-switch-row__content">
        <span class="md-switch-row__label pels-text-settings-label">Respond to prices</span>
        <small class="field__hint">
          When on, eligible devices boost while power is cheap and reduce while it is expensive.
        </small>
      </span>
    </label>
    <p id="respond-to-prices-hint" class="field__hint">
      {enabled
        ? 'Smart tasks also need this setting to plan when to run.'
        : 'While Respond to prices is off, any enabled smart tasks are paused.'}
    </p>
    <MdDialog open={offArmed && !busy}
      onClose={(event) => {
        if (!offArmed) return;
        // Escape/scrim already started closing. Let the controller's boolean
        // change own that close so two animations cannot race the next open.
        event.preventDefault();
        handlers.onOptimizationOffDismiss();
      }}>
      <div slot="headline">Turn off Respond to prices?</div>
      <div slot="content">
        Price-based device adjustments will stop. Any enabled smart tasks will pause and may miss their deadlines.
      </div>
      <div slot="actions">
        <MdTextButton onClick={handlers.onOptimizationOffDismiss}>Keep on</MdTextButton>
        <MdTextButton class="md-text-button--destructive" onClick={handlers.onOptimizationOffConfirm}>
          Turn off
        </MdTextButton>
      </div>
    </MdDialog>
  </>
  );
};

const DeviceRow = ({ device, handlers }: { device: PriceOptDevice; handlers: PriceAwareDevicesHandlers }) => {
  // Magnitudes, whatever sign an older save stored: the planner applies each
  // delta by its magnitude, so clamping a backwards sign to zero here showed a
  // number that does not take effect.
  const cheapBoost = Math.abs(device.cheapDelta);
  const expensiveReduction = Math.abs(device.expensiveDelta);
  const displayName = formatDisplayDeviceName(device.name);

  return (
    <div class="price-aware-grid__row">
      <span class="price-aware-grid__name entity-name">{displayName}</span>
      <div class="price-aware-grid__cell">
        <span class="price-aware-grid__cell-label eyebrow" aria-hidden="true">
          <span class="price-aware-grid__tone-dot price-aware-grid__tone-dot--cheap"></span>
          <span>Cheap</span>
        </span>
        <ValueAdjuster
          direction="up"
          value={cheapBoost}
          min={DELTA_MIN}
          max={DELTA_MAX}
          step={DELTA_STEP}
          unit="°C"
          increaseLabel={`Increase cheap-hour boost for ${displayName}`}
          decreaseLabel={`Decrease cheap-hour boost for ${displayName}`}
          onChange={(val) => handlers.onDevicePriceAdjustmentChange(device.id, 'cheap_hour_boost', val)}
        />
      </div>
      <div class="price-aware-grid__cell">
        <span class="price-aware-grid__cell-label eyebrow" aria-hidden="true">
          <span class="price-aware-grid__tone-dot price-aware-grid__tone-dot--expensive"></span>
          <span>Expensive</span>
        </span>
        <ValueAdjuster
          direction="down"
          value={expensiveReduction}
          min={DELTA_MIN}
          max={DELTA_MAX}
          step={DELTA_STEP}
          unit="°C"
          increaseLabel={`Increase expensive-hour reduction for ${displayName}`}
          decreaseLabel={`Decrease expensive-hour reduction for ${displayName}`}
          onChange={(val) => handlers.onDevicePriceAdjustmentChange(device.id, 'expensive_hour_reduction', val)}
        />
      </div>
    </div>
  );
};

const DevicesSection = ({ devices, handlers }: { devices: PriceOptDevice[]; handlers: PriceAwareDevicesHandlers }) => {
  if (devices.length === 0) {
    return (
      <div class="settings-form-card">
        <h3 class="pels-text-card-title">Devices</h3>
        <p class="muted">
          No eligible devices. Mark a temperature device as managed in Settings &rsaquo; Devices, then return here.
        </p>
        <div class="form__actions">
          <MdOutlinedButton type="button" data-settings-target="devices">
            Open Settings &rsaquo; Devices
          </MdOutlinedButton>
        </div>
      </div>
    );
  }

  return (
    <div class="settings-form-card">
      <h3 class="pels-text-card-title">Devices</h3>
      <p class="muted">
        Adjusts the current mode&apos;s target temperature: higher while power is cheap, lower while it is expensive.
      </p>
      <div class="price-aware-grid" role="grid" aria-label="Device temperature adjustments">
        <div class="price-aware-grid__head eyebrow" role="row">
          <span role="columnheader">Device</span>
          <span role="columnheader" class="price-aware-grid__col-head">
            <span class="price-aware-grid__tone-dot price-aware-grid__tone-dot--cheap" aria-hidden="true"></span>
            Cheap
          </span>
          <span role="columnheader" class="price-aware-grid__col-head">
            <span class="price-aware-grid__tone-dot price-aware-grid__tone-dot--expensive" aria-hidden="true"></span>
            Expensive
          </span>
        </div>
        {devices.map((device) => (
          <DeviceRow key={device.id} device={device} handlers={handlers} />
        ))}
      </div>
    </div>
  );
};

const PriceAwareDevicesRoot = (props: PriceAwareDevicesViewProps) => (
  <>
    <Header />
    <PriceSourceCard status={props.priceSetupStatus} />
    <RespondTogglesCard {...props} />
    {props.optimizationEnabled && <DevicesSection devices={props.devices} handlers={props.handlers} />}
  </>
);

export const renderPriceAwareDevicesView = (
  surface: HTMLElement,
  props: PriceAwareDevicesViewProps,
): void => {
  render(<PriceAwareDevicesRoot {...props} />, surface);
};
