import { ControlContestRecord } from '../../lib/executor/controlContest';
import { createDeviceEventStore } from '../../lib/diagnostics/deviceEventStore';
import { getLogger } from '../../lib/logging/logger';
import type { UserdataDatabase } from '../../lib/store/userdataDatabase';

const logger = getLogger('executor/control-contest');

/**
 * The executor's contest record, one for the app like the stepped stores it is
 * handed to. It is built with the app, before the userdata database opens, so
 * it opens the device journal when an event comes. A journal that cannot write
 * must not interrupt the command that produced the event (`DeviceJournal`).
 */
export const createControlContests = (
  getUserdataDatabase: () => UserdataDatabase,
): ControlContestRecord => new ControlContestRecord({
  record: (deviceIds, event) => {
    try {
      createDeviceEventStore(getUserdataDatabase()).record(deviceIds, event);
    } catch (error) {
      logger.error({ event: 'device_event_record_failed', deviceIds, recordedEvent: event.event, err: error });
    }
  },
});
