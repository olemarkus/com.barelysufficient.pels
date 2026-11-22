import { incPerfCounter } from '../../utils/perfCounters';

/** The perf-counter prefix under which every Homey REST call is counted. */
export const HOMEY_API_CALL_COUNTER_PREFIX = 'homey_api.';

// Device, zone, flow card and other ids in a path: UUIDs, and Homey's 24-hex ids.
const ID_SEGMENT = /\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})(?=\/|$|\?)/gi;

/** `GET /api/manager/devices/device/<uuid>` counts as `homey_api.GET manager/devices/device/:id`. */
export function countHomeyApiCall(method: string, urlPath: string): void {
  const path = urlPath.replace(/^\/api\//, '').replace(/\?.*$/, '').replace(ID_SEGMENT, '/:id');
  incPerfCounter(`${HOMEY_API_CALL_COUNTER_PREFIX}${method} ${path}`);
}
