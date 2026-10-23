import { getComponentLogger } from '../../lib/logging/logger';

/**
 * The component logger a spec hands a dep that requires one. Late-bound like
 * the runtime's, so `captureLogger` sees what it writes and an uncaptured spec
 * writes to the silent default root.
 */
export const testLogger = getComponentLogger('test');
