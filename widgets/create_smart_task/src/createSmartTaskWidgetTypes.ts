import type { CreateSmartTaskDevice } from '../../_shared/smartTaskCreate/types';

// The creation flow's wire shapes are shared with the Device widget.
export type {
  CreateSmartTaskCandidateRequest,
  CreateSmartTaskCreateResponse,
  CreateSmartTaskDevice,
  CreateSmartTaskPreviewResponse,
  CreateSmartTaskQuickTarget,
  CreateSmartTaskQuickTargetsResponse,
  CreateSmartTaskRejectReason,
} from '../../_shared/smartTaskCreate/types';

export type CreateSmartTaskDevicesPayload = {
  state: 'ready';
  devices: CreateSmartTaskDevice[];
} | {
  // No eligible devices to set a task on. A calm, expected state (the hint tells
  // the user how to make a device appear) — never the danger tone.
  state: 'empty';
  subtitle: string;
  hint: string | null;
} | {
  // The device fetch FAILED (a real `/devices` round-trip rejected), distinct
  // from `empty`. The widget can recover in place via a tap-to-retry affordance
  // that re-runs the load, so a stuck load no longer needs a close/reopen. The
  // subtitle/retry copy is the fixed `loadError`/`loadErrorRetry` pair (resolved
  // in render), so this carries no payload — the discriminant is the message.
  state: 'error';
};

