import { parseFriNettleieYaml } from './friNettleieYaml';
import { readFriNettleieTariffs, type FriNettleieTariffs } from './friNettleieTariff';

const FRI_NETTLEIE_TARIFF_BASE_URL = 'https://raw.githubusercontent.com/kraftsystemet/fri-nettleie/main/tariffer/';
const FETCH_TIMEOUT_MS = 15_000;
// Fri Nettleie's largest tariff file is about 20 kB.
const MAX_FILE_BYTES = 256 * 1024;

/** A Fri Nettleie file read for a day, or why it could not be. */
export type FriNettleieFileRead =
  | { kind: 'tariffs'; tariffs: FriNettleieTariffs }
  | { kind: 'unavailable'; reason: string };

/** A grid company's Fri Nettleie file as fetched: its tariffs and the text they were read from. */
export type FriNettleieFetchOutcome =
  | { kind: 'tariffs'; tariffs: FriNettleieTariffs; text: string }
  | { kind: 'unavailable'; reason: string };

/**
 * The Fri Nettleie file last fetched for a grid company, kept so its tariff
 * still prices each later day on its own day type and period while the file
 * cannot be fetched. Stored as fetched and read again for each day, so it holds
 * the tariff exactly as the live file did.
 */
export type SavedFriNettleieFile = {
  organizationNumber: string;
  file: string;
  text: string;
  fetchedAt: string;
};

/** A stored value as a {@link SavedFriNettleieFile}; `null` when it is absent or not one. */
export const readSavedFriNettleieFile = (value: unknown): SavedFriNettleieFile | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { organizationNumber, file, text, fetchedAt } = value as Record<string, unknown>;
  if (typeof organizationNumber !== 'string' || typeof file !== 'string') return null;
  if (typeof text !== 'string' || typeof fetchedAt !== 'string') return null;
  return { organizationNumber, file, text, fetchedAt };
};

/**
 * Read a Fri Nettleie file's text for `todayKey`: the periods still valid that
 * day or starting later. A file outside the supported format, or with no such
 * period, is `unavailable`, never a partial tariff. The file comes from Fri
 * Nettleie's main branch, so a period with an implausible fee is unreadable
 * (see `readFriNettleieTariffs`).
 */
export const readFriNettleieFile = (text: string, todayKey: string): FriNettleieFileRead => {
  let document: unknown;
  try {
    document = parseFriNettleieYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'unavailable', reason: `unreadable file: ${message}` };
  }
  const read = readFriNettleieTariffs(document, todayKey);
  if (read.kind === 'tariffs') return read;
  const reason = read.kind === 'none' ? 'no current tariff period' : 'unreadable tariff period';
  return { kind: 'unavailable', reason };
};

/* eslint-disable functional/immutable-data -- Chunks accumulate in place while the body streams in. */
// The body as text, or `null` once it passes `MAX_FILE_BYTES`: the cap holds on
// the bytes received, whatever the response declares, before anything larger
// is buffered.
const readCappedText = async (response: Awaited<ReturnType<typeof fetch>>): Promise<string | null> => {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    const value = chunk.value as Uint8Array;
    bytes += value.byteLength;
    if (bytes > MAX_FILE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};
/* eslint-enable functional/immutable-data */

/**
 * Fetch `file` (an operator file under `tariffer/` in Fri Nettleie) and read it
 * for `todayKey` (see `readFriNettleieFile`). A failed request or an oversized
 * file is `unavailable`.
 */
export const fetchFriNettleieFile = async (file: string, todayKey: string): Promise<FriNettleieFetchOutcome> => {
  let text: string;
  try {
    const response = await fetch(`${FRI_NETTLEIE_TARIFF_BASE_URL}${encodeURIComponent(file)}`, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return { kind: 'unavailable', reason: `HTTP ${response.status}` };
    const body = await readCappedText(response);
    if (body === null) return { kind: 'unavailable', reason: `file over ${MAX_FILE_BYTES} bytes` };
    text = body;
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  const read = readFriNettleieFile(text, todayKey);
  return read.kind === 'tariffs' ? { ...read, text } : read;
};
