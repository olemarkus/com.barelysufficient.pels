import type { TargetDeviceSnapshot } from '../../contracts/src/types';
import { NATIVE_WIRING_FLOW_CONFLICT_TITLE } from '../src/ui/deviceDetail/nativeWiringCopy';

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

  it('shows missing required activation independently of Flow detection', async () => {
    buildDom();
    const { setDeviceDetailNativeWiringState } = await import('../src/ui/deviceDetail/nativeWiring.ts');
    setDeviceDetailNativeWiringState(buildDevice({
      controlAdapter: { kind: 'capability_adapter', activationRequired: true, activationEnabled: false },
    }));
    expect(document.getElementById('device-detail-native-wiring-notice')?.hidden).toBe(false);
    expect(notice()?.hidden).toBe(true);
  });

  it('does not label optional, disabled built-in control as required for a legacy Flow setup', async () => {
    buildDom();
    const { setDeviceDetailNativeWiringState } = await import('../src/ui/deviceDetail/nativeWiring.ts');
    setDeviceDetailNativeWiringState(buildDevice({
      controlAdapter: {
        kind: 'capability_adapter', activationAvailable: true,
        activationRequired: false, activationEnabled: false,
      },
      flowConflict: { conflictingCapabilities: ['max_power_3000'] },
    }));
    expect(document.getElementById('device-detail-native-wiring-notice')?.hidden).toBe(true);
    expect(notice()?.hidden).toBe(false);
  });

  it('shows the banner with settings-UI-owned copy when the device has a flow conflict', async () => {
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

  it('names the conflicting Flow in the banner when a single Flow is responsible', async () => {
    buildDom();
    const { setDeviceDetailNativeWiringState } = await import('../src/ui/deviceDetail/nativeWiring.ts');

    setDeviceDetailNativeWiringState(buildDevice({
      flowConflict: { conflictingCapabilities: ['max_power_3000'], flowName: 'Charge at night' },
    }));

    expect(notice()?.hidden).toBe(false);
    expect(title()?.textContent).toContain('Charge at night');
    expect(title()?.textContent).not.toBe(NATIVE_WIRING_FLOW_CONFLICT_TITLE);
    expect(body()?.textContent).toContain('Charge at night');
    expect(body()?.textContent).toContain('Your Flow keeps working as it does now');
    expect(body()?.textContent).toContain('turn off only the action that controls this device');
    expect(body()?.textContent).not.toContain('Remove it');
    // Still no raw capability id in the user-facing copy.
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

  it('warns about competing control when built-in control and a conflicting Flow are both enabled', async () => {
    buildDom();
    const { setDeviceDetailNativeWiringState } = await import('../src/ui/deviceDetail/nativeWiring.ts');

    setDeviceDetailNativeWiringState(buildDevice({
      flowConflict: { conflictingCapabilities: ['max_power_3000'] },
      controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true },
    }));

    expect(notice()?.hidden).toBe(false);
    expect(body()?.textContent).toContain('may override each other');
    expect(body()?.textContent).not.toContain('left built-in device control');
    expect(document.getElementById('device-detail-native-wiring-notice')?.hidden).toBe(true);
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
