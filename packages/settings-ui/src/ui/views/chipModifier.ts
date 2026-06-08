// Maps a state `tone` token (active/idle/held/resuming/neutral/warning) onto the
// `plan-chip--{modifier}` family so the device-state chip uses the same primitive
// as the "Always on", Boost, Smart-task, and starvation chips. Shared between the
// live device cards (`PlanDeviceCards.tsx`) and the device log (`DeviceLogView.tsx`)
// so a logged state line wears the same colour it had when it was current.
const TONE_CHIP_MODIFIER: Record<string, string> = {
  active: 'good',
  resuming: 'good',
  held: 'limited',
  idle: 'muted',
  neutral: 'muted',
  warning: 'alert',
};

export const chipModifierForTone = (tone: string): string => TONE_CHIP_MODIFIER[tone] ?? 'muted';
