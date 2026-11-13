import type { DeviceDiagnosticConfiguration } from '../../lib/diagnostics/deviceDiagnosticConfiguration';

/** Configured rank deliberately differs from a compact plan's rank. */
export const deviceDiagnosticConfigurationFixture = (): DeviceDiagnosticConfiguration => ({
  modes: {
    state: 'resolved', homeId: 'main', catalogHomeId: 'main', activeMode: 'Home',
    modes: [
      { mode: 'Home', configuredRank: 7, targetTemperatureC: 23 },
      { mode: 'Night', configuredRank: 3, targetTemperatureC: 18 },
    ],
  },
  powerLimitControl: true,
  budgetExempt: false,
  startPolicy: 'pels_only',
  configuredShedBehavior: { action: 'set_temperature', temperature: 5, coolingTemperature: 30 },
  externalOffOptIn: { status: 'resolved', enabled: true },
});
