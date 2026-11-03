import { useState } from 'preact/hooks';
import type { EvChargingCurrentLimits } from '../../../../contracts/src/types.ts';
import { readEvChargingCurrentLimits } from '../../../../shared-domain/src/settings/evChargingCurrentLimits.ts';
import { MdFilledTextField, MdOutlinedButton } from './materialWebJSX.tsx';

interface ChargingCurrentLimitsViewProps {
  scope: 'car' | 'charger';
  subjectId: string;
  subjectName: string;
  limits: EvChargingCurrentLimits;
  hasSavedLimits: boolean;
  onSave: (limits: EvChargingCurrentLimits) => Promise<boolean>;
  onReset: () => Promise<boolean>;
}

export function ChargingCurrentLimitsView(props: ChargingCurrentLimitsViewProps) {
  const [minA, setMinA] = useState(String(props.limits.minA));
  const [maxA, setMaxA] = useState(String(props.limits.maxA));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const persist = async (operation: () => Promise<boolean>) => {
    setError('');
    setBusy(true);
    try {
      if (!await operation()) setError('Charging current limits could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const limits = readEvChargingCurrentLimits({
      minA: minA.trim() ? Number(minA) : Number.NaN,
      maxA: maxA.trim() ? Number(maxA) : Number.NaN,
    });
    if (!limits) {
      setError('Enter whole amps from 6 to 32. Minimum must not exceed maximum.');
      return;
    }
    await persist(() => props.onSave(limits));
  };
  const carOverride = props.scope === 'car';
  const fieldId = (bound: string) => `${props.scope}-charging-current-${encodeURIComponent(props.subjectId)}-${bound}`;
  return <section class="charging-current-setup">
    <h4 class="pels-text-settings-label">{carOverride
      ? `Charging current limits for ${props.subjectName}` : 'Default charging current limits'}</h4>
    <p class="field__hint">{carOverride
      ? 'A saved car range overrides the charger default whenever this car is matched, including other chargers. Clear it to use the charger default.'
      : 'Used when the connected car has no saved override, including cars PELS cannot match. A matched car’s saved range replaces this default.'}
      {' '}The charger’s physical limits still apply, and PELS can pause charging.</p>
    {carOverride && <p class="field__hint">{props.hasSavedLimits ? 'Saved car override' : 'Using charger default until you save a car override.'}</p>}
    <MdFilledTextField id={fieldId('min')} label="Minimum current" suffix-text="A" type="number" min="6" max="32" step="1"
      value={minA} disabled={busy}
      onInput={(event: Event) => setMinA((event.currentTarget as HTMLElement & { value: string }).value)} />
    <MdFilledTextField id={fieldId('max')} label="Maximum current" suffix-text="A" type="number" min="6" max="32" step="1"
      value={maxA} disabled={busy}
      onInput={(event: Event) => setMaxA((event.currentTarget as HTMLElement & { value: string }).value)} />
    {error && <p class="field__hint" role="alert">{error}</p>}
    <MdOutlinedButton disabled={busy} onClick={save}>{carOverride ? 'Save car override' : 'Save charger default'}</MdOutlinedButton>
    {props.hasSavedLimits && <MdOutlinedButton disabled={busy} onClick={() => persist(props.onReset)}>
      {carOverride ? 'Use charger default' : 'Clear charger default'}
    </MdOutlinedButton>}
  </section>;
}
