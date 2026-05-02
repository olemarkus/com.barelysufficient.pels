import type {
  HomeyDeviceLike,
  NativeSteppedLoadBlockReasonCode,
  NativeSteppedLoadStatusSnapshot,
  SteppedLoadProfile,
} from '../utils/types';
import type { DeviceCapabilityMap } from './deviceManagerControl';

const ZAPTEC_OWNER_URI = 'homey:app:com.zaptec';
const ZAPTEC_REQUIRED_CAPABILITIES = [
  'measure_power',
  'available_installation_current',
  'charging_button',
  'charge_mode',
  'alarm_generic.car_connected',
] as const;
const ZAPTEC_DRIVER_ACTION_IDS = {
  'homey:app:com.zaptec:go': 'installation_current_control',
  'homey:app:com.zaptec:go2': 'go2_installation_current_control',
  'homey:app:com.zaptec:home': 'home_installation_current_control',
  'homey:app:com.zaptec:pro': 'pro_installation_current_control',
} as const;
const ZAPTEC_STEP_SEQUENCE = [
  { id: 'off', currentA: 0 },
  { id: '6a', currentA: 6 },
  { id: '8a', currentA: 8 },
  { id: '10a', currentA: 10 },
  { id: '12a', currentA: 12 },
  { id: '16a', currentA: 16 },
  { id: '20a', currentA: 20 },
  { id: '24a', currentA: 24 },
  { id: '28a', currentA: 28 },
  { id: '32a', currentA: 32 },
] as const;

const ZAPTEC_STEP_BY_ID = new Map(ZAPTEC_STEP_SEQUENCE.map((step) => [step.id, step]));
const ZAPTEC_DEFAULT_MODEL_LABEL = 'Zaptec stepped current: 1-phase default model';
const ZAPTEC_SHARED_INSTALLATION_MESSAGE = [
  'Blocked: Zaptec stepped current is disabled when multiple chargers share the same installation.',
].join(' ');
const ZAPTEC_POWER_MISMATCH_MESSAGE = [
  'Blocked: measured power does not match the built-in Zaptec 1-phase model.',
  'PELS has fallen back to pause/resume control.',
].join(' ');
const ZAPTEC_CURRENT_TOLERANCE_A = 0.6;
const ZAPTEC_POWER_MISMATCH_SAMPLE_COUNT = 2;

type ZaptecSteppedRuntimeStatus = NativeSteppedLoadStatusSnapshot & {
  installationId?: string;
};

type ZaptecStepId = (typeof ZAPTEC_STEP_SEQUENCE)[number]['id'];

export const ZAPTEC_NATIVE_STEPPED_LOAD_PROFILE: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: ZAPTEC_STEP_SEQUENCE.map((step) => ({
    id: step.id,
    planningPowerW: step.currentA * 230,
  })),
};

export function isZaptecNativeSteppedLoadWiringCandidate(params: {
  device: HomeyDeviceLike;
  capabilities: readonly string[];
}): boolean {
  const { device, capabilities } = params;
  if (normalizeText(device.class) !== 'evcharger') return false;
  const driverId = normalizeText(device.driverId ?? device.driver?.id);
  if (!(driverId in ZAPTEC_DRIVER_ACTION_IDS)) return false;
  const ownerUri = normalizeText(device.ownerUri ?? device.driverUri ?? device.driver?.owner_uri ?? device.driver?.uri);
  if (ownerUri !== '' && ownerUri !== ZAPTEC_OWNER_URI) return false;
  return ZAPTEC_REQUIRED_CAPABILITIES.every((capabilityId) => capabilities.includes(capabilityId));
}

export function resolveZaptecNativeSteppedLoadProfileSuggestion(params: {
  device: HomeyDeviceLike;
  capabilities: readonly string[];
}): SteppedLoadProfile | undefined {
  return isZaptecNativeSteppedLoadWiringCandidate(params)
    ? ZAPTEC_NATIVE_STEPPED_LOAD_PROFILE
    : undefined;
}

export function resolveZaptecNativeSteppedLoadReportedStepId(params: {
  capabilityObj: DeviceCapabilityMap;
}): string | undefined {
  const { capabilityObj } = params;
  if (capabilityObj['alarm_generic.car_connected']?.value === false) return 'off';
  if (capabilityObj.charging_button?.value === false) return 'off';
  return resolveZaptecStepIdFromCurrent(capabilityObj.available_installation_current?.value);
}

export function resolveZaptecFlowActionId(device: HomeyDeviceLike): string | undefined {
  const driverId = normalizeText(device.driverId ?? device.driver?.id);
  return ZAPTEC_DRIVER_ACTION_IDS[driverId as keyof typeof ZAPTEC_DRIVER_ACTION_IDS];
}

export function resolveZaptecInstallationId(device: HomeyDeviceLike): string | undefined {
  const installationId = device.data && typeof device.data === 'object'
    ? device.data.installationId
    : undefined;
  return typeof installationId === 'string' && installationId.trim()
    ? installationId.trim()
    : undefined;
}

export function buildZaptecSharedInstallationBlockSet(devices: readonly HomeyDeviceLike[]): Set<string> {
  const counts = new Map<string, number>();
  for (const device of devices) {
    const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
    if (!isZaptecNativeSteppedLoadWiringCandidate({ device, capabilities })) continue;
    const installationId = resolveZaptecInstallationId(device);
    if (!installationId) continue;
    counts.set(installationId, (counts.get(installationId) ?? 0) + 1);
  }
  return new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([installationId]) => installationId),
  );
}

export function buildZaptecNativeSteppedStatus(params: {
  reportedStepId?: string;
  blockedReasonCode?: NativeSteppedLoadBlockReasonCode;
}): ZaptecSteppedRuntimeStatus {
  const { reportedStepId, blockedReasonCode } = params;
  return {
    provider: 'zaptec',
    modelLabel: ZAPTEC_DEFAULT_MODEL_LABEL,
    currentStepLabel: reportedStepId ? formatCurrentStepLabel(reportedStepId) : undefined,
    blockedReasonCode,
    blockedMessage: resolveBlockedMessage(blockedReasonCode),
  };
}

export function isZaptecPowerMismatch(params: {
  expectedStepId: string;
  measuredPowerW: unknown;
}): boolean {
  const expectedStep = ZAPTEC_STEP_BY_ID.get(params.expectedStepId as ZaptecStepId);
  if (!expectedStep) return false;
  if (typeof params.measuredPowerW !== 'number' || !Number.isFinite(params.measuredPowerW)) return false;
  const expectedPowerW = expectedStep.currentA * 230;
  return params.measuredPowerW > Math.max(expectedPowerW + 900, expectedPowerW * 1.7);
}

export function getZaptecPowerMismatchSampleCount(): number {
  return ZAPTEC_POWER_MISMATCH_SAMPLE_COUNT;
}

export function getZaptecRequestedCurrentA(stepId: string): number | undefined {
  return ZAPTEC_STEP_BY_ID.get(stepId as ZaptecStepId)?.currentA;
}

function resolveZaptecStepIdFromCurrent(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const nearest = ZAPTEC_STEP_SEQUENCE.find((step) => Math.abs(value - step.currentA) <= ZAPTEC_CURRENT_TOLERANCE_A);
  return nearest?.id;
}

function formatCurrentStepLabel(stepId: string): string | undefined {
  const step = ZAPTEC_STEP_BY_ID.get(stepId as ZaptecStepId);
  if (!step) return undefined;
  return `Current stepped model: ${step.id} / ${(step.currentA * 230 / 1000).toFixed(2)} kW`;
}

function resolveBlockedMessage(
  reasonCode: NativeSteppedLoadBlockReasonCode | undefined,
): string | undefined {
  switch (reasonCode) {
    case 'zaptec_stepped_blocked_shared_installation':
      return ZAPTEC_SHARED_INSTALLATION_MESSAGE;
    case 'zaptec_stepped_blocked_power_mismatch':
      return ZAPTEC_POWER_MISMATCH_MESSAGE;
    default:
      return undefined;
  }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
