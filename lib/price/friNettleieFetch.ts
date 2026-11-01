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
    const declaredBytes = Number(response.headers?.get('content-length'));
    if (declaredBytes > MAX_FILE_BYTES) return { kind: 'unavailable', reason: `file of ${declaredBytes} bytes` };
    text = await response.text();
    if (text.length > MAX_FILE_BYTES) return { kind: 'unavailable', reason: `file of ${text.length} characters` };
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
  const tariffs = readFriNettleieTariffs(document, todayKey);
  return tariffs ? { kind: 'tariffs', tariffs } : { kind: 'unavailable', reason: 'no current tariff period' };
};
