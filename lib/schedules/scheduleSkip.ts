/** A refusal reported as written: the occurrence was skipped, nothing failed. */
export class ScheduleSkip extends Error {
  /** `deviceBusy`: the device still has a Smart task, which PELS may still be ending after its ready-by. */
  constructor(message: string, readonly deviceBusy = false) {
    super(message);
  }
}
