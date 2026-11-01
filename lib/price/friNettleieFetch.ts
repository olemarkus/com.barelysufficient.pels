import { parseFriNettleieYaml } from './friNettleieYaml';
import { readFriNettleieTariffs, type FriNettleieTariffs } from './friNettleieTariff';

const FRI_NETTLEIE_TARIFF_BASE_URL = 'https://raw.githubusercontent.com/kraftsystemet/fri-nettleie/main/tariffer/';
const FETCH_TIMEOUT_MS = 15_000;
// Fri Nettleie's largest tariff file is about 20 kB.
const MAX_FILE_BYTES = 256 * 1024;

/** A grid company's Fri Nettleie tariff as fetched, or why it could not be read. */
export type FriNettleieFetchOutcome =
  | { kind: 'tariffs'; tariffs: FriNettleieTariffs }
  | { kind: 'unavailable'; reason: string };

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
 * Fetch and read `file` (an operator file under `tariffer/` in Fri Nettleie),
 * keeping the periods still valid on `todayKey` or starting later. A failed
 * request, an oversized file, a file outside the supported format, or a file
 * with no such period is `unavailable`, never a partial tariff. The file is
 * read live from Fri Nettleie's main branch, so a period with an implausible
 * fee is dropped (see `readFriNettleieTariffs`).
 */
export const fetchFriNettleieTariffs = async (file: string, todayKey: string): Promise<FriNettleieFetchOutcome> => {
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
