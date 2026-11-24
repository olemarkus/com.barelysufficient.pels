import { foldChargingInstallations } from '../../lib/planInput/chargingInstallationFold';
import type { PlanInputSnapshotDevice } from '../../lib/planInput/runtimeDeviceRead';

const adapter = {
  kind: 'capability_adapter' as const, activationRequired: false, activationEnabled: false,
  chargingInstallation: { id: 'inst', mainId: 'main', memberIds: ['main', 'second', 'third'] },
};
const member = (id: string, drawKw: number, on: boolean) => ({
  id, available: true, controlModel: 'binary_power', measuredPowerKw: drawKw, measuredPowerIsDirectMeasurement: true,
  binaryControl: { on }, controlAdapter: adapter,
}) as unknown as PlanInputSnapshotDevice;
const noLevel = { readChargingInstallationLevelW: () => undefined };

describe('foldChargingInstallations', () => {
  it('plans the installation as one entry with the summed draw, leaving each member\'s own reading', () => {
    const devices = [
      member('main', 1.5, true), member('second', 4, true),
      member('third', 0, false), { id: 'heater', measuredPowerKw: 2 } as PlanInputSnapshotDevice,
    ];
    const folded = foldChargingInstallations(devices, noLevel);
    expect(folded.map((device) => [device.id, device.measuredPowerKw])).toEqual([
      ['main', 1.5], ['second', 4], ['third', 0], ['heater', 2],
    ]);
    expect(folded[0]?.chargingInstallationLoad).toEqual({ control: 'switch_only', currentDrawKw: 5.5, running: true });
    expect(folded[1]?.chargingInstallationLoad).toBeUndefined();
  });

  it('reads the installation on while any member is on', () => {
    const [main] = foldChargingInstallations(
      [member('main', 0, false), member('second', 4, true)], noLevel,
    );
    expect(main?.binaryControl).toEqual({ on: false });
    expect(main?.chargingInstallationLoad?.running).toBe(true);
  });

  it('can prepare a step with the chargers off and the shared level unreadable', () => {
    const devices = [member('main', 0, false), member('second', 0, false)];
    const [main] = foldChargingInstallations(devices, noLevel);
    expect(main?.chargingInstallationLoad).toEqual({ control: 'step', currentDrawKw: 0, running: false });
  });

  it('leaves a list without a charging installation as it is', () => {
    const devices = [{ id: 'heater', measuredPowerKw: 2 } as PlanInputSnapshotDevice];
    expect(foldChargingInstallations(devices, noLevel)).toEqual(devices);
  });
});
