import type { DeviceStatus } from '../../../packages/contracts/src/deviceStatus';
import type { CreateSmartTaskDevice } from '../../_shared/smartTaskCreate/types';
import type {
  SmartTasksWidgetEndedRow,
  SmartTasksWidgetRow,
} from '../../smart_tasks/src/smartTasksWidgetTypes';

// The Device insight widget's read for one device: the overview card's status, the
// device's smart task, and whether a new task can be started on it.

export type DeviceWidgetTask =
  | { kind: 'none' }
  | {
    // The open task, as a Smart task list row: the tile summarises it and a tap
    // opens the same detail panel the list opens.
    kind: 'active';
    row: SmartTasksWidgetRow;
    // "Next run 02:00", while a planned hour is still ahead.
    nextRunLabel: string | null;
  }
  | {
    // The newest task that ended today: the morning-after answer.
    kind: 'ended';
    row: SmartTasksWidgetEndedRow;
  };

export type DeviceWidgetPayload =
  | {
    state: 'ready';
    device: {
      id: string;
      name: string;
      status: DeviceStatus;
      // The charger's linked car, when PELS knows it.
      carName: string | null;
    };
    task: DeviceWidgetTask;
    // The device as the creation flow takes it, when a new task can be started
    // on it now (no task running, and the device takes one).
    createDevice: CreateSmartTaskDevice | null;
  }
  // The chosen device is not in PELS's plan (removed, or no longer managed).
  | { state: 'not_managed' }
  // The app has built no plan since it started.
  | { state: 'starting' };
