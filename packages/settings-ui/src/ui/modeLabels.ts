export const DEFAULT_MODE_NAME = 'Home';

export const resolveModeName = (mode: string): string => mode.trim() || DEFAULT_MODE_NAME;

export const formatModeLabel = (mode: string): string => `${resolveModeName(mode)} mode`;
