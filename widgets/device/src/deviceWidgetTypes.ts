import type { DeviceStatus } from '../../../packages/contracts/src/deviceStatus';
import type { CreateSmartTaskDevice } from '../../_shared/smartTaskCreate/types';
import type { SmartTasksWidgetTone } from '../../smart_tasks/src/smartTasksWidgetTypes';

// The Device widget's read for one device: the overview card's status, the
// device's smart task, and whether a new task can be started on it.

export type DeviceWidgetTask =
  | { kind: 'none' }
  | {
    // A running task, worded as the Smart tasks widget words it.
    kind: 'active';
    // "Charge to 80%" / "Heat to 65 °C".
    goalLabel: string;
    // "Ready by 07:00" / "Due 07:00".
    deadlineLabel: string;
    statusLabel: string;
    tone: SmartTasksWidgetTone;
    // Why the task stands as it does, when its status needs saying.
    whyLabel: string | null;
    // "Next run 02:00", while a planned hour is still ahead.
    nextRunLabel: string | null;
  }
  | {
    // The newest task that ended today: the morning-after answer.
    kind: 'ended';
    goalLabel: string;
    outcomeLabel: string;
    tone: SmartTasksWidgetTone;
    // "Reached at 05:42", or why it was missed, or when it ended.
    detailLabel: string;
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
