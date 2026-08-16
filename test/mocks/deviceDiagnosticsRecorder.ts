import type { Mock } from 'vitest';
import type { DeviceDiagnosticsRecorder } from '../../lib/diagnostics/deviceDiagnosticsServiceTypes';

/** Every member of the port, spied, each spy carrying that member's own signature. */
export type DeviceDiagnosticsRecorderStub = {
  [K in keyof DeviceDiagnosticsRecorder]: Mock<DeviceDiagnosticsRecorder[K]>;
};

/**
 * A complete `DeviceDiagnosticsRecorder` of spies.
 *
 * Tests that only care about one or two members used to build a partial object literal and cast it
 * — which meant a new member on the recorder never reached them, and neither did a changed
 * signature on the members they DO assert against.
 *
 * The return type is the mapped type above rather than a trailing `satisfies`: `satisfies` checks
 * only that the object is assignable to the port, which a bare `vi.fn()` (`Mock<(...args: any[]) =>
 * any>`) always is. That would leave every call site and `toHaveBeenCalledWith` unchecked — the one
 * thing this helper exists to prevent. Parameterizing each spy with `DeviceDiagnosticsRecorder[K]`
 * is what actually holds the stub to the production signatures.
 */
export const buildDeviceDiagnosticsRecorderStub = (): DeviceDiagnosticsRecorderStub => ({
  observePlanSample: vi.fn(),
  recordControlEvent: vi.fn(),
  recordActivationTransition: vi.fn(),
  getUiPayload: vi.fn(),
});
