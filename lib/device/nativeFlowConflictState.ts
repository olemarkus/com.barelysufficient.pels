/**
 * The native-wiring Flow conflicts PELS last accepted: which Hoiax or Easee
 * devices a user Flow writes the setting of that built-in control would
 * write, and which Flow, for the device notice. Native wiring holds an owner's
 * built-in choice back while a device is in it (`resolveNativeWiringEnabled`
 * in `builtInControlFlowGate.ts`).
 *
 * Kept across a restart (`createNativeFlowConflictStore`): `restoreSaved`
 * runs when the userdata database opens, before the transport's first parse,
 * so a known conflict holds built-in control back from boot. Every accepted
 * scan is saved through `accept`, an unchanged one included: the store writes
 * no row that did not change, so that costs nothing and heals a save that
 * failed earlier. Saving is best-effort; a failure is logged and costs only
 * the restart window it covers.
 */
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import type {
  AcceptedFlowConflictSlice, NativeFlowConflict, NativeFlowConflicts,
} from '../flowApi/acceptedFlowConflictStore';

const logger = getLogger('device/native-flow-conflicts');

export class NativeFlowConflictState {
  private conflicts: NativeFlowConflicts = {};

  constructor(private readonly store: AcceptedFlowConflictSlice<NativeFlowConflicts>) {}

  /** The accepted conflicts, by device id. Replaced, never changed in place. */
  get all(): NativeFlowConflicts { return this.conflicts; }

  get(deviceId: string): NativeFlowConflict | undefined { return this.conflicts[deviceId]; }

  /** Seeds what the last accepted scan before the restart found; an unreadable store leaves none. */
  restoreSaved(): void {
    try {
      this.conflicts = this.store.read();
    } catch (error) {
      logger.error({ event: 'native_flow_conflicts_restore_failed', err: normalizeError(error) });
    }
  }

  /** Takes an accepted scan's conflicts, or puts back the previous ones after a failed apply. */
  accept(conflicts: NativeFlowConflicts): void {
    this.conflicts = conflicts;
    try {
      this.store.write(conflicts);
    } catch (error) {
      logger.error({ event: 'native_flow_conflicts_save_failed', err: normalizeError(error) });
    }
  }
}
