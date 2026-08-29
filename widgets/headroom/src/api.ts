import { handleWidgetClientLog, type WidgetClientLogContext } from '../../_shared/widgetClientLogApi';
import { hasPowerMeasurement } from '../../../lib/power/lastTotalPower';
import {
  asPowerStatusBlobRead,
  classifyPowerStatusRead,
  type PowerMeasurementEvidence,
} from '../../../setup/settingsUiAppRuntime';
import { buildHeadroomWidgetPayload } from './headroomWidgetPayload';
import type { HeadroomWidgetPayload } from './headroomWidgetTypes';

const PELS_STATUS_SETTING = 'pels_status';

// The widget API handler runs app-side (like the settings-UI api handlers),
// so `homey.app` is the running PELS app and the live tracker latch is
// reachable — the same evidence the plan-build gate and the ui_power
// composers classify against. Typed `unknown` and narrowed below: the app
// shell is untrusted structure at this seam, and an unreadable app must
// classify as no measurement rather than serve the persisted blob as live.
type WidgetApiContext = {
  homey: {
    app: unknown;
    settings: {
      get: (key: string) => unknown;
    };
  };
};

const toLatchEvidence = (app: unknown): PowerMeasurementEvidence => {
  if (app === null || typeof app !== 'object') return { state: 'none' };
  const tracker = (app as { powerTracker?: unknown }).powerTracker;
  if (tracker === null || tracker === undefined || typeof tracker !== 'object') {
    return { state: 'none' };
  }
  return hasPowerMeasurement(tracker)
    ? { state: 'latched' }
    : { state: 'none' };
};

export const getHeadroom = async ({ homey }: WidgetApiContext): Promise<HeadroomWidgetPayload> => (
  buildHeadroomWidgetPayload({
    status: classifyPowerStatusRead(
      toLatchEvidence(homey.app),
      asPowerStatusBlobRead(homey.settings.get(PELS_STATUS_SETTING)),
    ),
  })
);

export const logClientError = (context: WidgetClientLogContext): { ok: boolean } => (
  handleWidgetClientLog('headroom', context)
);
