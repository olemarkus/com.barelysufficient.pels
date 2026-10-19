import type { DeviceStatus } from '../../../../packages/contracts/src/deviceStatus';
import type { CreateSmartTaskDevice } from '../../../_shared/smartTaskCreate/types';
import type { DeviceWidgetPayload } from '../deviceWidgetTypes';

// Canned tiles for `?preview=1` (design preview and the widget harness), one per
// state the tile has to read right in: `?state=<key>`. Obviously fictional;
// never reached on a real boot.

const status = (fields: Partial<DeviceStatus>): DeviceStatus => ({
  cardKind: 'binary',
  kind: 'active',
  tone: 'active',
  label: 'Running',
  powerText: null,
  powerVariant: 'live',
  factText: null,
  reading: null,
  reason: null,
  rail: null,
  limited: false,
  wouldLimit: false,
  canEaseOff: true,
  controlOffDrawing: false,
  holdCause: null,
  ...fields,
});

const heaterCandidate: CreateSmartTaskDevice = {
  deviceId: 'heater', deviceName: 'Water heater', kind: 'temperature', unitSymbol: '°C',
  goalMin: 20, goalMax: 85, goalStep: 1, defaultGoal: 65, currentValue: 54,
  supportsLimitLowerPriority: false, offersQuickTargets: true,
};

const chargerCandidate: CreateSmartTaskDevice = {
  deviceId: 'ev', deviceName: 'Garage charger', kind: 'ev_soc', unitSymbol: '%',
  goalMin: 1, goalMax: 100, goalStep: 1, defaultGoal: 80, currentValue: null,
  supportsLimitLowerPriority: true, offersQuickTargets: false,
};

const PREVIEW_PAYLOADS: Record<string, DeviceWidgetPayload> = {
  ev: {
    state: 'ready',
    device: {
      id: 'ev', name: 'Garage charger', carName: 'Model Y',
      status: status({ cardKind: 'stepped', label: 'Charging', powerText: '7.2 kW',
        factText: 'Charging · 58 % · level 16 A', reading: { kind: 'battery', percent: 58 } }),
    },
    task: {
      kind: 'active', goalLabel: 'Charge to 80%', deadlineLabel: 'Ready by 07:00', statusLabel: 'On track',
      tone: 'ok', whyLabel: null, nextRunLabel: 'Next run 02:00',
    },
    createDevice: null,
  },
  heater: {
    state: 'ready',
    device: {
      id: 'heater', name: 'Water heater', carName: null,
      status: status({ cardKind: 'temperature', kind: 'held', tone: 'held', label: 'Limited', powerText: '0.0 kW',
        factText: '54.0 °C · target 65 °C', reading: { kind: 'temperature', currentC: 54, targetC: 65 },
        reason: { text: 'Waiting to resume — 0.8 kW more needed' }, limited: true, canEaseOff: false }),
    },
    task: { kind: 'none' },
    createDevice: heaterCandidate,
  },
  ended: {
    state: 'ready',
    device: {
      id: 'heater', name: 'Water heater', carName: null,
      status: status({ cardKind: 'temperature', powerText: '2.0 kW', factText: '63.0 °C · target 65 °C',
        reading: { kind: 'temperature', currentC: 63, targetC: 65 } }),
    },
    task: {
      kind: 'ended', goalLabel: 'Heat to 65 °C', outcomeLabel: 'Succeeded', tone: 'ok',
      detailLabel: 'Reached at 05:48',
    },
    createDevice: heaterCandidate,
  },
  nocar: {
    state: 'ready',
    device: {
      id: 'ev', name: 'Garage charger', carName: null,
      status: status({ kind: 'idle', tone: 'idle', label: 'Idle', factText: 'Unplugged', canEaseOff: false }),
    },
    task: { kind: 'none' },
    createDevice: chargerCandidate,
  },
  plain: {
    state: 'ready',
    device: {
      id: 'floor', name: 'Floor heating bath', carName: null,
      status: status({ powerText: '1.1 kW' }),
    },
    task: { kind: 'none' },
    createDevice: null,
  },
  not_managed: { state: 'not_managed' },
  starting: { state: 'starting' },
};

export const resolveDeviceWidgetPreviewPayload = (state: string | null): DeviceWidgetPayload => (
  PREVIEW_PAYLOADS[state ?? 'ev'] ?? PREVIEW_PAYLOADS.ev
);
