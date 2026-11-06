export type ChipTone = 'good' | 'warn' | 'limited' | 'alert' | 'info' | 'muted' | 'outline';

const CHIP_TONES: readonly ChipTone[] = ['good', 'warn', 'limited', 'alert', 'info', 'muted', 'outline'];

export const CHIP_TONE_CLASSES = CHIP_TONES.map((tone) => `plan-chip--${tone}`);

// Device presentation states retain their domain vocabulary at the view boundary.
const STATE_TONES: Record<string, ChipTone> = {
  active: 'good', resuming: 'good', held: 'limited', idle: 'muted', neutral: 'muted', warning: 'alert',
};

export const chipToneForState = (tone: string): ChipTone => STATE_TONES[tone] ?? 'muted';
