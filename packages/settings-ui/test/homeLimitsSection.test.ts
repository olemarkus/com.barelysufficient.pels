import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderHomeLimitsSection,
  type HomeLimitsEditorView,
  type HomeLimitsSectionProps,
} from '../src/ui/views/HomeLimitsSection.tsx';
import { resolveHomeLimitsStatus } from '../../shared-domain/src/homeLimitsStatus.ts';

/* -------------------------------------------------------------------------- *
 * Per-home Limits section render tests: progressive-disclosure visibility, the
 * simulation activation notice (dry-run only), and the status card sourced from
 * the resolved pels_status blob. Which home is selected belongs to the shell's
 * scope bar (`homeScope.test.ts`), not this surface.
 * -------------------------------------------------------------------------- */

const noop = (): void => {};

const baseEditor = (overrides: Partial<HomeLimitsEditorView> = {}): HomeLimitsEditorView => ({
  areaName: 'Utleie',
  hardCapValue: '7',
  marginValue: '0.3',
  dryRun: true,
  runtimeActive: true,
  controlBusy: false,
  marginError: null,
  reactionKw: '6.7 kW',
  status: resolveHomeLimitsStatus(
    { controlledKw: 2, uncontrolledKw: 1, powerNowKw: 3, hasLivePowerSample: true, devicesOff: 1, limitReason: 'hourly' },
    { dryRun: true, hardCapKw: 7 },
  ),
  onHardCapInput: noop,
  onHardCapChange: noop,
  onMarginInput: noop,
  onMarginChange: noop,
  onControlToggle: noop,
  ...overrides,
});

const baseProps = (overrides: Partial<HomeLimitsSectionProps> = {}): HomeLimitsSectionProps => ({
  editor: null,
  ...overrides,
});

const mountWith = (props: HomeLimitsSectionProps): HTMLElement => {
  const surface = document.createElement('div');
  document.body.append(surface);
  renderHomeLimitsSection(surface, props);
  return surface;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('progressive disclosure', () => {
  it('renders nothing while the Main home is the selected scope', () => {
    // The Main home's editor is the static form outside this mount, and a
    // single-meter home never selects anything else — so this surface stays
    // empty and the panel keeps its single-meter layout.
    const surface = mountWith(baseProps());
    expect(surface.textContent).toBe('');
    expect(surface.querySelector('#home-limits-hard-cap')).toBeNull();
    expect(surface.querySelector('#home-limits-status')).toBeNull();
  });
});

describe('meter-area editor', () => {
  it('renders the cap + margin fields and the reaction readout', () => {
    const surface = mountWith(baseProps({ editor: baseEditor() }));
    expect(surface.querySelector<HTMLInputElement>('#home-limits-hard-cap')?.value).toBe('7');
    expect(surface.querySelector<HTMLInputElement>('#home-limits-margin')?.value).toBe('0.3');
    expect(surface.querySelector('#home-limits-reaction')?.textContent).toBe('6.7 kW');
  });

  it('shows the activation notice ONLY while the area is OFF (simulating)', () => {
    const withSim = mountWith(baseProps({ editor: baseEditor({ dryRun: true }) }));
    expect(withSim.querySelector('#home-limits-sim-notice')).not.toBeNull();
    expect(withSim.textContent).toContain('only simulating “Utleie”');
    // Positive toggle: OFF (simulating) means the switch is NOT selected.
    const offSwitch = withSim.querySelector('#home-limits-simulation-switch') as HTMLElement & { selected: boolean };
    expect(offSwitch.selected).toBe(false);
    document.body.innerHTML = '';
    const active = mountWith(baseProps({
      editor: baseEditor({
        dryRun: false,
        status: resolveHomeLimitsStatus({ limitReason: 'none', devicesOff: 0 }, { dryRun: false, hardCapKw: 7 }),
      }),
    }));
    expect(active.querySelector('#home-limits-sim-notice')).toBeNull();
    // Control ON ⇒ the switch is selected (green matches the "Active" chip).
    const onSwitch = active.querySelector('#home-limits-simulation-switch') as HTMLElement & { selected: boolean };
    expect(onSwitch.selected).toBe(true);
  });

  it('renders a held legacy area as not active and disables its control toggle', () => {
    const surface = mountWith(baseProps({
      editor: baseEditor({ dryRun: false, runtimeActive: false }),
    }));
    const sw = surface.querySelector('#home-limits-simulation-switch') as HTMLElement & {
      selected: boolean;
    };
    expect(sw.selected).toBe(false);
    expect(sw.hasAttribute('disabled')).toBe(true);
    expect(surface.querySelector('#home-limits-inactive-notice')?.textContent)
      .toContain('open Multiple meters and save this area');
    expect(surface.querySelector('#home-limits-status-chip')?.textContent).toBe('Not active');
    expect(surface.querySelector('#home-limits-status-power')?.textContent).toBe('—');
    expect(surface.querySelector('#home-limits-status-line')?.textContent)
      .toBe('Open Multiple meters and save this area to start using these settings.');
  });

  it('shows the margin-vs-cap alert when present', () => {
    const surface = mountWith(baseProps({
      editor: baseEditor({ marginError: 'Safety margin must be less than the hard cap. Lower the margin to continue.' }),
    }));
    expect(surface.querySelector('#home-limits-margin-alert')?.textContent)
      .toContain('Safety margin must be less than the hard cap');
  });

  it('renders the status card from the resolved blob (power now, cap, posture, state line)', () => {
    const surface = mountWith(baseProps({ editor: baseEditor({ dryRun: true }) }));
    expect(surface.querySelector('#home-limits-status-power')?.textContent).toBe('3.0 kW');
    expect(surface.querySelector('#home-limits-status-cap')?.textContent).toBe('7.0 kW');
    expect(surface.querySelector('#home-limits-status-chip')?.textContent).toBe('Simulating');
    expect(surface.querySelector('#home-limits-status-line')?.textContent).toBe('Simulating — would limit 1 device.');
  });

  it('drives the control toggle callback with the switch selected state', () => {
    const onControlToggle = vi.fn();
    const surface = mountWith(baseProps({
      editor: baseEditor({ onControlToggle }),
    }));
    const sw = surface.querySelector('#home-limits-simulation-switch') as HTMLElement & { selected: boolean };
    // Turning the switch ON = enabling control.
    sw.selected = true;
    sw.dispatchEvent(new Event('change'));
    expect(onControlToggle).toHaveBeenCalledWith(true);
  });

  it('disables the control toggle while a write is in flight', () => {
    const busy = mountWith(baseProps({
      editor: baseEditor({ controlBusy: true }),
    }));
    expect(busy.querySelector('#home-limits-simulation-switch')!.hasAttribute('disabled')).toBe(true);
    document.body.innerHTML = '';
    const idle = mountWith(baseProps({
      editor: baseEditor({ controlBusy: false }),
    }));
    expect(idle.querySelector('#home-limits-simulation-switch')!.hasAttribute('disabled')).toBe(false);
  });
});
