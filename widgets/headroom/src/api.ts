import { handleWidgetClientLog, type WidgetClientLogContext } from '../../_shared/widgetClientLogApi';
import { hasPowerMeasurement } from '../../../lib/power/lastTotalPower';
import { MAIN_HOME_ID } from '../../../lib/utils/settingsKeys';
import { planStatusRegistryOf } from '../../../lib/plan/planStatusRegistry';
import {
  classifyPowerStatusRead,
  type PowerMeasurementEvidence,
  type PowerStatusBlobRead,
} from '../../../setup/settingsUiAppRuntime';
import { buildHeadroomWidgetPayload } from './headroomWidgetPayload';
import type { HeadroomWidgetPayload } from './headroomWidgetTypes';

// The widget API handler runs app-side (like the settings-UI api handlers),
// so `homey.app` is the running PELS app: the main home's live status and
// the live tracker latch are both reachable — the same evidence the
// plan-build gate and the ui_power composers classify against. Typed
// `unknown` and narrowed below: the app shell is untrusted structure at this
// seam, and an unreadable app must classify as no measurement and no status.
type WidgetApiContext = {
  homey: {
    app: unknown;
  };
};

const toStatusRead = (app: unknown): PowerStatusBlobRead => {
  const read = planStatusRegistryOf(app)?.read(MAIN_HOME_ID);
  return read?.state === 'resolved' ? { state: 'resolved', status: read.status } : { state: 'absent' };
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
    status: classifyPowerStatusRead(toLatchEvidence(homey.app), toStatusRead(homey.app)),
  })
);

export const logClientError = (context: WidgetClientLogContext): { ok: boolean } => (
  handleWidgetClientLog('headroom', context)
);
