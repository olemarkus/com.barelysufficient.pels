import { DeviceDiagnosticsService } from '../../lib/diagnostics/deviceDiagnosticsService';
import { createDeviceDiagnosticsStateStoreForApp } from './deviceDiagnosticsStateStore';
import type { AppContext } from '../../lib/app/appContext';

export const createDeviceDiagnosticsService = (ctx: AppContext): DeviceDiagnosticsService => (
  new DeviceDiagnosticsService({
    diagnosticsStateStore: createDeviceDiagnosticsStateStoreForApp(ctx),
    getTimeZone: () => ctx.getTimeZone(),
    isDebugEnabled: () => ctx.debugLoggingTopics.has('diagnostics'),
    structuredLog: ctx.getStructuredLogger('diagnostics'),
    debugStructured: ctx.getStructuredDebugEmitter('diagnostics', 'diagnostics'),
  })
);
