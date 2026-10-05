import { handleWidgetClientLog, type WidgetClientLogContext } from '../../_shared/widgetClientLogApi';
import type { PriceWidgetHostApi } from '../../../packages/contracts/src/widgetHostApi';
import { buildPriceWidgetPayload, resolvePriceWidgetShow } from './priceWidgetPayload';
import type { PriceWidgetPayload } from './priceWidgetTypes';

type WidgetApiContext = {
  homey: {
    // Absent while the app is unwired during a restart, so presence stays a
    // runtime question at this seam.
    app?: PriceWidgetHostApi;
    // The widget API runs in the app process (often UTC), so the owner's time
    // zone is read from the Homey clock for the hour and day labels.
    clock: { getTimezone: () => string };
  };
  query?: {
    show?: string;
  };
};

export const getTimeline = async ({ homey, query }: WidgetApiContext): Promise<PriceWidgetPayload> => (
  buildPriceWidgetPayload(
    typeof homey.app?.getPriceTimelineForUi === 'function'
      ? homey.app.getPriceTimelineForUi()
      : { state: 'unavailable', reason: 'no_prices' },
    resolvePriceWidgetShow(query?.show),
    Date.now(),
    homey.clock.getTimezone(),
  )
);

export const logClientError = (context: WidgetClientLogContext): { ok: boolean } => (
  handleWidgetClientLog('price', context)
);
