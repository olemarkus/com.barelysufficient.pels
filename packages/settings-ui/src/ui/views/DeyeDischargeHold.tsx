import { useState } from 'preact/hooks';
import type { DeyeDischargeHoldSetup, DeyeDischargeHoldStatus } from '../../../../contracts/src/deyeDischargeHold.ts';
import {
  MdCheckbox, MdFilledButton, MdFilledSelect, MdFilledTextField, MdOutlinedButton, MdSelectOption,
} from './materialWebJSX.tsx';

const STATUS_TEXT: Record<DeyeDischargeHoldStatus['state'], string> = {
  disabled: 'Deye battery discharge hold is off.',
  ready: 'Connected. PELS can hold Deye battery discharge during EV Smart tasks in Main.',
  pending: 'Waiting for Deye Cloud to confirm the discharge limit.',
  held: 'PELS has set the Deye discharge limit to 0 A.',
  unavailable: 'PELS could not check the connection. Check Deye Cloud and refresh the status.',
  recovery_required: 'Check the inverter’s discharge limit in Deye Cloud before continuing.',
};

export const isDeyeStatusState = (state: unknown): state is DeyeDischargeHoldStatus['state'] => (
  typeof state === 'string' && Object.hasOwn(STATUS_TEXT, state)
);

type ConnectionDraft = Omit<DeyeDischargeHoldSetup, 'acknowledgeRisk'>;
const EMPTY_CONNECTION: ConnectionDraft = {
  region: 'eu', email: '', password: '', appId: '', appSecret: '', deviceSn: '',
};

const FIELDS = [
  { key: 'email', label: 'Deye Cloud email', type: 'email' },
  { key: 'password', label: 'Deye Cloud password', type: 'password' },
  { key: 'appId', label: 'Deye developer app ID', type: 'text' },
  { key: 'appSecret', label: 'Deye developer app secret', type: 'password' },
  { key: 'deviceSn', label: 'Inverter serial number', type: 'text' },
] as const;

const fieldValue = (event: Event): string => (event.currentTarget as HTMLInputElement).value;
const fieldChecked = (event: Event): boolean => (event.currentTarget as HTMLInputElement).checked;

type ConnectDeyeProps = {
  busy: boolean;
  onSave: (input: DeyeDischargeHoldSetup) => Promise<boolean>;
  target?: DeyeDischargeHoldStatus;
};

function ConnectDeye({ busy, onSave, target }: ConnectDeyeProps) {
  const initialDraft = {
    ...EMPTY_CONNECTION,
    region: target?.region ?? EMPTY_CONNECTION.region,
    deviceSn: target?.deviceSn ?? EMPTY_CONNECTION.deviceSn,
  };
  const [draft, setDraft] = useState(initialDraft);
  const [acknowledged, setAcknowledged] = useState(false);
  const ready = acknowledged && FIELDS.every(({ key }) => draft[key].trim() !== '');
  return <div class="form-grid">
    {target
      ? <p class="field__hint">Use the same inverter and region. If a restore is pending, PELS will
        retry it with the new credentials. Once the original limit is restored, connect again to enable holds.</p>
      : <p class="field__hint">Connect one inverter for EV Smart tasks in Main.</p>}
    <p class="field__hint">Use your Deye Cloud account and credentials from the{' '}
      <a href="https://developer.deyecloud.com/" target="_blank" rel="noopener noreferrer">Deye developer portal</a>.
    </p>
    <MdFilledSelect label="Deye Cloud region" value={draft.region} disabled={busy || Boolean(target?.region)}
      onChange={(event: Event) => {
        const region = fieldValue(event);
        if (region === 'eu' || region === 'am' || region === 'india') setDraft({ ...draft, region });
      }}>
      <MdSelectOption value="eu">Europe</MdSelectOption>
      <MdSelectOption value="am">Americas</MdSelectOption>
      <MdSelectOption value="india">India</MdSelectOption>
    </MdFilledSelect>
    {FIELDS.map(({ key, label, type }) => <MdFilledTextField key={key} label={label} type={type}
      autocomplete={type === 'password' ? 'new-password' : 'off'} value={draft[key]}
      disabled={busy || (key === 'deviceSn' && Boolean(target?.deviceSn))}
      onInput={(event: Event) => setDraft({ ...draft, [key]: fieldValue(event) })} />)}
    <div class="pels-notice-warning">
      <p>PELS can set the inverter’s maximum discharge current to 0 A during a booked EV Smart task. This applies to the
        whole home. The limit may stay at 0 A through an outage, and you may have to restore it in Deye Cloud.</p>
      <p>While using this feature, leave the discharge limit unchanged in other apps and automations.
        PELS does not use this connection to cover your household power limits.</p>
      <label>
        <MdCheckbox checked={acknowledged} disabled={busy}
          aria-label="I can restore the discharge limit in Deye Cloud"
          onChange={(event: Event) => setAcknowledged(fieldChecked(event))} />
        <span>I can restore the discharge limit in Deye Cloud.</span>
      </label>
    </div>
    <div class="form__actions">
      <MdFilledButton disabled={busy || !ready} onClick={async () => {
        if (await onSave({ ...draft, acknowledgeRisk: true })) {
          setDraft(initialDraft);
          setAcknowledged(false);
        }
      }}>{target ? 'Replace credentials' : 'Connect inverter'}</MdFilledButton>
    </div>
  </div>;
}

type DeyeManualRecoveryProps = {
  status: DeyeDischargeHoldStatus;
  busy: boolean;
  onAcknowledge: () => void;
};

function DeyeManualRecovery({ status, busy, onAcknowledge }: DeyeManualRecoveryProps) {
  const [confirmed, setConfirmed] = useState(false);
  const { originalLimitA, orderId, deviceSn } = status;
  return <div class="pels-notice-warning" role="group" aria-label="Restore Deye battery discharge">
    {deviceSn && <p>Inverter serial number <strong>{deviceSn}</strong></p>}
    {orderId && <p>Deye Cloud order <strong>{orderId}</strong></p>}
    <p>Open the inverter’s Remote Control page in Deye Cloud and check the Control Log.
      Verify that the last command from PELS has finished before changing the discharge limit.
      If you cannot find the command, ask Deye support to check for a pending discharge-limit change.</p>
    {originalLimitA === undefined
      ? <p>PELS could not read the saved limit. Check the inverter’s configuration and ask Deye support if needed.</p>
      : <>
        <p>After the command has finished, restore the previous maximum discharge current of{' '}
          <strong>{originalLimitA} A</strong> in Deye Cloud.</p>
        <label>
          <MdCheckbox checked={confirmed} disabled={busy}
            aria-label="The last command has finished and I restored the previous limit"
            onChange={(event: Event) => setConfirmed(fieldChecked(event))} />
          <span>The last command has finished and I restored the previous limit.</span>
        </label>
        <div class="form__actions">
          <MdFilledButton disabled={busy || !confirmed} onClick={() => {
            setConfirmed(false);
            onAcknowledge();
          }}>Verify restored limit</MdFilledButton>
        </div>
      </>}
  </div>;
}

type DeyeDischargeHoldViewProps = {
  status: DeyeDischargeHoldStatus | null;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onSave: (input: DeyeDischargeHoldSetup) => Promise<boolean>;
  onDisable: () => void;
  onAcknowledge: () => void;
};

function DeyeCredentials({ status, busy, onSave }: Pick<DeyeDischargeHoldViewProps, 'status' | 'busy' | 'onSave'>) {
  if (status?.deviceSn) return <details>
    <summary>Replace Deye Cloud credentials</summary>
    <ConnectDeye key={status.deviceSn} busy={busy} onSave={onSave} target={status} />
  </details>;
  return status?.state === 'disabled' ? <ConnectDeye busy={busy} onSave={onSave} /> : null;
}

export function DeyeDischargeHoldView(props: DeyeDischargeHoldViewProps) {
  const { status, busy, error, onRefresh, onSave, onDisable, onAcknowledge } = props;
  const needsRecovery = status?.state === 'recovery_required';
  return <details class="settings-form-card">
    <summary>Deye battery discharge hold{needsRecovery ? ' · Check discharge limit' : ''}</summary>
    {error && <p role="alert" class="field__hint">{error}</p>}
    {status && <p role="status" class="field__hint">{STATUS_TEXT[status.state]}</p>}
    {busy && <p role="status" class="field__hint">Checking Deye Cloud…</p>}
    {needsRecovery && status && <DeyeManualRecovery key={status.orderId ?? status.originalLimitA}
      status={status} busy={busy} onAcknowledge={onAcknowledge} />}
    <DeyeCredentials status={status} busy={busy} onSave={onSave} />
    <div class="form__actions">
      <MdOutlinedButton disabled={busy} onClick={onRefresh}>Refresh status</MdOutlinedButton>
      {status?.enabled && <MdOutlinedButton disabled={busy} onClick={onDisable}>
        Disable discharge hold
      </MdOutlinedButton>}
    </div>
  </details>;
}
