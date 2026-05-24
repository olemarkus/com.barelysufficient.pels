import { render } from 'preact';
import type { PriceOptDevice } from '../priceConfigTypes.ts';
import { MdIconButton, MdOutlinedButton, MdSwitch, MdTextButton } from './materialWebJSX.tsx';
import { ArrowBackIcon } from './icons.tsx';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';

export type PriceAwareDevicesViewProps = {
  optimizationEnabled: boolean;
  devices: PriceOptDevice[];
  onOptimizationToggle: (enabled: boolean) => void;
  onDeviceCheapDeltaChange: (id: string, val: number) => void;
  onDeviceExpensiveDeltaChange: (id: string, val: number) => void;
};

const DELTA_MIN = 0;
const DELTA_MAX = 20;
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
  <>
    <MdTextButton
      class="settings-back-button"
      data-settings-target="settings"
    >
      <ArrowBackIcon slot="icon" />
      Settings
    </MdTextButton>
    <header class="pels-hero">
      <div>
        <p class="eyebrow">Price-aware devices</p>
        <h2>Cheap-hour boost and expensive-hour reduction</h2>
      </div>
    </header>
  </>
);

const RespondTogglesCard = ({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (val: boolean) => void;
}) => (
  <div class="field checkbox-field settings-form-card">
    <MdSwitch
      aria-label="Respond to prices"
      {...(enabled ? { selected: true } : {})}
      onChange={(e) => onToggle((e.currentTarget as SwitchElement).selected)}
    />
    <span class="checkbox-field__content">
      <span class="field__label">Respond to prices</span>
      <small class="field__hint">
        When on, eligible devices boost during cheap hours and reduce during expensive hours.
      </small>
    </span>
  </div>
);

const DeviceRow = ({
  device,
  onCheapChange,
  onExpensiveChange,
}: {
  device: PriceOptDevice;
  onCheapChange: (val: number) => void;
  onExpensiveChange: (val: number) => void;
}) => {
  const cheapBoost = Math.max(DELTA_MIN, device.cheapDelta);
  const expensiveReduction = Math.max(DELTA_MIN, -device.expensiveDelta);
  const displayName = formatDisplayDeviceName(device.name);

  return (
    <div class="price-aware-grid__row">
      <span class="price-aware-grid__name">{displayName}</span>
      <div class="price-aware-grid__cell">
        <span class="price-aware-grid__cell-label" aria-hidden="true">
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
          onChange={(val) => onCheapChange(val)}
        />
      </div>
      <div class="price-aware-grid__cell">
        <span class="price-aware-grid__cell-label" aria-hidden="true">
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
          onChange={(val) => onExpensiveChange(-val)}
        />
      </div>
    </div>
  );
};

const DevicesSection = ({
  devices,
  onDeviceCheapDeltaChange,
  onDeviceExpensiveDeltaChange,
}: {
  devices: PriceOptDevice[];
  onDeviceCheapDeltaChange: (id: string, val: number) => void;
  onDeviceExpensiveDeltaChange: (id: string, val: number) => void;
}) => {
  if (devices.length === 0) {
    return (
      <div class="settings-form-card">
        <h3 class="section-title">Devices</h3>
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
      <h3 class="section-title">Devices</h3>
      <p class="muted">
        Adjusts the current mode&apos;s target temperature: higher in cheap hours, lower in expensive hours.
      </p>
      <div class="price-aware-grid" role="grid" aria-label="Device temperature adjustments">
        <header class="price-aware-grid__head" role="row">
          <span role="columnheader">Device</span>
          <span role="columnheader" class="price-aware-grid__col-head">
            <span class="price-aware-grid__tone-dot price-aware-grid__tone-dot--cheap" aria-hidden="true"></span>
            Cheap
          </span>
          <span role="columnheader" class="price-aware-grid__col-head">
            <span class="price-aware-grid__tone-dot price-aware-grid__tone-dot--expensive" aria-hidden="true"></span>
            Expensive
          </span>
        </header>
        {devices.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            onCheapChange={(val) => onDeviceCheapDeltaChange(device.id, val)}
            onExpensiveChange={(val) => onDeviceExpensiveDeltaChange(device.id, val)}
          />
        ))}
      </div>
    </div>
  );
};

const PriceAwareDevicesRoot = (props: PriceAwareDevicesViewProps) => (
  <>
    <Header />
    <RespondTogglesCard enabled={props.optimizationEnabled} onToggle={props.onOptimizationToggle} />
    {props.optimizationEnabled && (
      <DevicesSection
        devices={props.devices}
        onDeviceCheapDeltaChange={props.onDeviceCheapDeltaChange}
        onDeviceExpensiveDeltaChange={props.onDeviceExpensiveDeltaChange}
      />
    )}
  </>
);

export const renderPriceAwareDevicesView = (
  surface: HTMLElement,
  props: PriceAwareDevicesViewProps,
): void => {
  render(<PriceAwareDevicesRoot {...props} />, surface);
};
