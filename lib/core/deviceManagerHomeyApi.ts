import type Homey from 'homey';
import type { HomeyDeviceLike } from '../utils/types';

export function resolveHomeyInstance(homey: Homey.App): Homey.App['homey'] {
  if (isHomeyAppWrapper(homey)) {
    return homey.homey;
  }
  return homey as unknown as Homey.App['homey'];
}

export async function getRawDevices(
  homey: Homey.App,
  path: string,
): Promise<Record<string, HomeyDeviceLike> | HomeyDeviceLike[]> {
  const api = extractHomeyApi(homey);
  if (!api?.get) {
    throw new Error('Homey API client not available');
  }
  const data = await api.get(path);
  if (Array.isArray(data)) return data as HomeyDeviceLike[];
  if (typeof data === 'object' && data !== null) return data as Record<string, HomeyDeviceLike>;
  return [];
}

export function writeErrorToStderr(message: string, error: unknown): void {
  const stderr = typeof process !== 'undefined' ? process.stderr : undefined;
  if (!stderr || typeof stderr.write !== 'function') return;
  const errorText = error instanceof Error ? (error.stack || error.message) : String(error);
  try {
    stderr.write(`[PelsApp] ${message} ${errorText}\n`);
  } catch (_) {
    // ignore stderr failures
  }
}

function isHomeyAppWrapper(value: unknown): value is { homey: Homey.App['homey'] } {
  return typeof value === 'object' && value !== null && 'homey' in value;
}

function extractHomeyApi(homey: Homey.App): { get?: (path: string) => Promise<unknown> } | undefined {
  const homeyInstance = resolveHomeyInstance(homey);
  return (homeyInstance as { api?: { get?: (path: string) => Promise<unknown> } }).api;
}
