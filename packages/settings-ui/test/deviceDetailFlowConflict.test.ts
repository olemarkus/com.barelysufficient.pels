import type { TargetDeviceSnapshot } from '../../contracts/src/types';
import { NATIVE_WIRING_FLOW_CONFLICT_TITLE } from '../../shared-domain/src/nativeWiringCopy';

const buildDom = () => {
  document.body.innerHTML = `
    <details id="device-detail-setup-disclosure"><summary></summary></details>
    <div id="device-detail-native-wiring-notice" hidden></div>
    <md-text-button id="device-detail-native-wiring-notice-action"></md-text-button>
    <div id="device-detail-flow-conflict-notice" hidden>
      <span id="device-detail-flow-conflict-title"></span>
      <small id="device-detail-flow-conflict-body"></small>
    </div>
    <div id="device-detail-native-wiring-row" hidden></div>
    <md-switch id="device-detail-native-wiring"></md-switch>
    <div id="device-detail-native-wiring-confirm-row" hidden></div>
    <md-switch id="device-detail-native-wiring-confirm"></md-switch>
  `;
};

const buildDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'hoiax-1',
  name: 'Water heater',
  targets: [],
  capabilities: ['onoff'],
  ...overrides,
} as TargetDeviceSnapshot);

describe('device detail flow-conflict banner', () => {
  afterEach(() => {
    vi.resetModules();
  });

  const notice = () => document.getElementById('device-detail-flow-conflict-notice');
  const title = () => document.getElementById('device-detail-flow-conflict-title');
  const body = () => document.getElementById('device-detail-flow-conflict-body');

  it('shows the banner with shared-domain copy when the device has a flow conflict', async () => {
    buildDom();
    const { setDeviceDetailNativeWiringState } = await import('../src/ui/deviceDetail/nativeWiring.ts');

    setDeviceDetailNativeWiringState(buildDevice({
      flowConflict: { conflictingCapabilities: ['max_power_3000'] },
    }));

    expect(notice()?.hidden).toBe(false);
    expect(title()?.textContent).toBe(NATIVE_WIRING_FLOW_CONFLICT_TITLE);
    expect((body()?.textContent ?? '').length).toBeGreaterThan(0);
    // No raw capability id leaks into the user-facing copy.
    expect(body()?.textContent).not.toContain('max_power_3000');
  });

  it('auto-expands the Setup disclosure so the banner is visible', async () => {
    buildDom();
    const disclosure = document.getElementById('device-detail-setup-disclosure') as HTMLDetailsElement;
    disclosure.open = false;
    const { setDeviceDetailNativeWiringState } = await import('../src/ui/deviceDetail/nativeWiring.ts');

    setDeviceDetailNativeWiringState(buildDevice({
      flowConflict: { conflictingCapabilities: ['max_power_3000'] },
    }));

    expect(disclosure.open).toBe(true);
    expect(notice()?.hidden).toBe(false);
  });

  it('hides the banner once native wiring is enabled (override), even with a conflict', async () => {
    buildDom();
    const { setDeviceDetailNativeWiringState } = await import('../src/ui/deviceDetail/nativeWiring.ts');

    setDeviceDetailNativeWiringState(buildDevice({
      flowConflict: { conflictingCapabilities: ['max_power_3000'] },
      controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true },
    }));

    // Control is on (override), so "PELS left control off" no longer applies.
    expect(notice()?.hidden).toBe(true);
  });

  it('hides the banner when there is no flow conflict', async () => {
    buildDom();
    const { setDeviceDetailNativeWiringState } = await import('../src/ui/deviceDetail/nativeWiring.ts');

    setDeviceDetailNativeWiringState(buildDevice());
    expect(notice()?.hidden).toBe(true);

    setDeviceDetailNativeWiringState(buildDevice({ flowConflict: { conflictingCapabilities: [] } }));
    expect(notice()?.hidden).toBe(true);
  });
});
