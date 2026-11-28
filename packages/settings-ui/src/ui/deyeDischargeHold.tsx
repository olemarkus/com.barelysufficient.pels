import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { CHARGING_ACCESS_CHECK_PATH, CHARGING_ACCESS_PATH } from '../../../contracts/src/chargingControl.ts';
import type { DeyeDischargeHoldSetup, DeyeDischargeHoldStatus } from '../../../contracts/src/deyeDischargeHold.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import { callApi } from './homey.ts';
import { DeyeDischargeHoldView, isDeyeStatusState } from './views/DeyeDischargeHold.tsx';

const DEYE_PATH = `${CHARGING_ACCESS_PATH}?provider=deye`;
const DEYE_CHECK_PATH = `${CHARGING_ACCESS_CHECK_PATH}?provider=deye`;

const isDeyeRegion = (value: unknown): value is DeyeDischargeHoldSetup['region'] => (
  value === 'eu' || value === 'am' || value === 'india'
);

const readStatus = async (response: Promise<unknown>): Promise<DeyeDischargeHoldStatus> => {
  const raw = await response;
  if (!isUnknownRecord(raw) || typeof raw.enabled !== 'boolean' || !isDeyeStatusState(raw.state)) {
    throw new Error('Deye status unavailable');
  }
  return {
    enabled: raw.enabled,
    state: raw.state,
    ...(isDeyeRegion(raw.region) ? { region: raw.region } : {}),
    ...(typeof raw.deviceSn === 'string' ? { deviceSn: raw.deviceSn } : {}),
    ...(typeof raw.orderId === 'string' ? { orderId: raw.orderId } : {}),
    ...(typeof raw.originalLimitA === 'number' && Number.isSafeInteger(raw.originalLimitA) && raw.originalLimitA >= 0
      ? { originalLimitA: raw.originalLimitA } : {}),
  };
};

const fetchStatus = () => readStatus(callApi('GET', DEYE_PATH));
const saveConnection = (input: DeyeDischargeHoldSetup) => readStatus(callApi('PUT', DEYE_PATH, input));
const disableHold = () => readStatus(callApi('POST', DEYE_CHECK_PATH, { provider: 'deye', action: 'disable' }));
const acknowledgeRecovery = () => readStatus(callApi('POST', DEYE_CHECK_PATH, {
  provider: 'deye', action: 'acknowledge', confirmedOrderSettled: true,
}));

function DeyeDischargeHoldPanel() {
  const [status, setStatus] = useState<DeyeDischargeHoldStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (operation: () => Promise<DeyeDischargeHoldStatus>, failure: string): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      setStatus(await operation());
      return true;
    } catch {
      setError(failure);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const refresh = () => run(fetchStatus, 'Could not load Deye battery status. Try again.');
  useEffect(() => { void refresh(); }, []);
  return <DeyeDischargeHoldView status={status} busy={busy} error={error}
    onRefresh={() => { void refresh(); }}
    onSave={(input) => run(() => saveConnection(input),
      'Could not connect to Deye Cloud. Check your credentials, region and inverter serial number.')}
    onDisable={() => { void run(disableHold,
      'Could not disable the hold. Refresh the status and check the discharge limit in Deye Cloud.'); }}
    onAcknowledge={() => { void run(acknowledgeRecovery,
      'Could not verify the restored limit. Check the command history and discharge limit in Deye Cloud.'); }} />;
}

export function mountDeyeDischargeHold(): void {
  const root = document.getElementById('deye-discharge-hold-root');
  if (root) render(<DeyeDischargeHoldPanel />, root);
}
