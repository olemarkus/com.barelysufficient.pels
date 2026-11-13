import { useEffect, useState } from 'preact/hooks';
import type { ChargingPhaseMode, ChargingPhaseName, ChargingPhaseRead, ChargingPhaseStatus } from '../../../../contracts/src/chargingPhases.ts';
import { MdFilledSelect, MdOutlinedButton, MdSelectOption, MdSwitch, readSwitchSelected } from './materialWebJSX.tsx';

type SupportedRead = Extract<ChargingPhaseRead, { kind: 'supported' }>;
type Mode = 'charger' | ChargingPhaseMode;
type SinglePhaseChoice = ChargingPhaseName | 'unselected';

export function chargingPhaseStatusText(status: ChargingPhaseStatus): string {
  switch (status.kind) {
    case 'charger': return 'Phase control is left to the charger.';
    case 'ready': return status.phases === 1 ? 'One-phase charging.' : 'Three phases permitted.';
    case 'waiting': return 'Keeping the current phases before changing again.';
    case 'preparing': return `Lowering current before changing to ${status.to === 1 ? 'one phase' : 'three phases'}…`;
    case 'switching': return `Changing to ${status.to === 1 ? 'one phase' : 'three phases'}…`;
    case 'failed': return status.reason;
    case 'releasing': return 'Returning phase control to the charger…';
    default: { const exhaustive: never = status; return exhaustive; }
  }
}

const MODES: readonly [Mode, string][] = [
  ['charger', 'Leave to charger'], ['automatic', 'Automatic'], ['single', 'One phase'], ['three', 'Three phases'],
];

export type ChargingPhasesViewProps = {
  read: SupportedRead;
  singlePhase: SinglePhaseChoice;
  onSave: (mode: Mode, singlePhase: SinglePhaseChoice) => Promise<boolean>;
};

export function ChargingPhasesView(props: ChargingPhasesViewProps) {
  const [mode, setMode] = useState<Mode>(props.read.mode);
  const [singlePhase, setSinglePhase] = useState(props.singlePhase);
  useEffect(() => setSinglePhase(props.singlePhase), [props.singlePhase]);
  const [confirmed, setConfirmed] = useState(props.read.installationConfirmed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (!await props.onSave(mode, singlePhase)) setError('Charging phases could not be saved. Try again.');
    } finally { setBusy(false); }
  };
  return <section class="charging-current-setup">
    <h4 class="pels-text-settings-label">Charging phases</h4>
    <p class="field__hint">Automatic uses one or three phases to match available power, solar and your smart task.</p>
    <p class="field__hint" role="status">{chargingPhaseStatusText(props.read.status)}</p>
    <MdFilledSelect label="Charging phases" value={mode} disabled={busy} onChange={(event: Event) => {
      const value = (event.currentTarget as HTMLElement & { value: string }).value;
      const option = MODES.find(([id]) => id === value);
      if (option) setMode(option[0]);
    }}>
      {MODES.map(([value, label]) => <MdSelectOption key={value} value={value} displayText={label}>
        <div slot="headline">{label}</div>
      </MdSelectOption>)}
    </MdFilledSelect>
    {mode !== 'charger' && <>
      <MdFilledSelect label="House phase" value={singlePhase} disabled={busy}
        onChange={(event: Event) => {
          const value = (event.currentTarget as HTMLElement & { value: string }).value;
          if (value === 'L1' || value === 'L2' || value === 'L3') setSinglePhase(value);
        }}>
        <MdSelectOption value="unselected" displayText="Choose a house phase" disabled>
          <div slot="headline">Choose a house phase</div>
        </MdSelectOption>
        {(['L1', 'L2', 'L3'] as const).map((phase) => <MdSelectOption key={phase} value={phase} displayText={phase}>
          <div slot="headline">{phase}</div>
        </MdSelectOption>)}
      </MdFilledSelect>
      <p class="field__hint">The house phase used when charging on one phase.</p>
      <label class={busy ? 'md-switch-row md-switch-row--disabled' : 'md-switch-row'}>
        <span class="md-switch-row__content"><span class="md-switch-row__label pels-text-settings-label">This installation supports phase switching</span>
          <small class="field__hint">A 400 V three-phase supply with neutral, a compatible charger and a car that supports changing phases during charging.</small>
        </span>
        <MdSwitch aria-label="This installation supports phase switching" selected={confirmed} disabled={busy}
          onChange={(event: Event) => setConfirmed(readSwitchSelected(event))} />
      </label>
    </>}
    {error && <p class="field__hint" role="alert">{error}</p>}
    <MdOutlinedButton disabled={busy || (mode !== 'charger' && (!confirmed || singlePhase === 'unselected'))}
      onClick={save}>Save charging phases</MdOutlinedButton>
  </section>;
}
