import { buildHeadroomWidgetPayload, type HeadroomWidgetInput } from './headroomWidgetPayload';
import type { HeadroomWidgetPayload } from './headroomWidgetTypes';

const PELS_STATUS_SETTING = 'pels_status';

type WidgetApiContext = {
  homey: {
    settings: {
      get: (key: string) => unknown;
    };
  };
};

const readStatus = (raw: unknown): HeadroomWidgetInput['status'] => {
  if (!raw || typeof raw !== 'object') return null;
  return raw as HeadroomWidgetInput['status'];
};

export const getHeadroom = async ({ homey }: WidgetApiContext): Promise<HeadroomWidgetPayload> => {
  const status = readStatus(homey.settings.get(PELS_STATUS_SETTING));
  return buildHeadroomWidgetPayload({ status });
};
