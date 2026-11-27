import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { SupportReportDocument, SupportReportSection } from '../../packages/contracts/src/supportReport';

const BATCH_CHARS = 32 * 1024;

function* arrayParts<T>(items: readonly T[], parts?: (item: T) => Iterable<string>): Generator<string> {
  yield '[';
  let separator = '';
  for (const item of items) {
    yield separator;
    if (parts && item != null) yield* parts(item);
    else yield JSON.stringify(item) ?? 'null';
    separator = ',';
  }
  yield ']';
}

type FieldParts = (key: string, value: unknown) => Iterable<string> | undefined;

/** Preserve field order and use the standard serializer for fields outside the large collections. */
function* objectParts(object: object, fieldParts: FieldParts): Generator<string> {
  yield '{';
  let separator = '';
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue;
    yield separator + JSON.stringify(key) + ':';
    const parts = fieldParts(key, value);
    if (parts) yield* parts;
    else yield JSON.stringify(value);
    separator = ',';
  }
  yield '}';
}

function objectWithArray(object: object, arrayKey: string): Iterable<string> {
  return objectParts(object, (key, value) => (
    key === arrayKey && Array.isArray(value) ? arrayParts(value) : undefined
  ));
}

function sectionParts(section: SupportReportSection): Iterable<string> {
  return objectParts(section, (key) => (
    key === 'values' ? objectWithArray(section.values, 'devices') : undefined
  ));
}

function documentParts(document: SupportReportDocument): Iterable<string> {
  return objectParts(document, (key) => {
    switch (key) {
      case 'log': return objectWithArray(document.log, 'lines');
      case 'activity': return objectWithArray(document.activity, 'entries');
      case 'deviceEvents': return objectWithArray(document.deviceEvents, 'entries');
      case 'sections': return arrayParts(document.sections, sectionParts);
      default: return undefined;
    }
  });
}

/** Batch complete JSON pieces so UTF-8 encoding never splits a surrogate pair. */
function* gzipInput(document: SupportReportDocument): Generator<Buffer> {
  let batch = '';
  for (const piece of documentParts(document)) {
    batch += piece;
    if (batch.length >= BATCH_CHARS) {
      yield Buffer.from(batch);
      batch = '';
    }
  }
  if (batch) yield Buffer.from(batch);
}

export async function gzipSupportReportJson(document: SupportReportDocument): Promise<{
  buffer: Buffer; jsonBytes: number;
}> {
  const gzip = createGzip();
  const buffers: Buffer[] = [];
  await pipeline(Readable.from(gzipInput(document), { objectMode: false }), gzip, async (
    chunks: AsyncIterable<Buffer>,
  ) => {
    /* eslint-disable functional/immutable-data -- Append chunks until the complete frame can be encoded. */
    for await (const chunk of chunks) buffers.push(chunk);
    /* eslint-enable functional/immutable-data */
  });
  return { buffer: Buffer.concat(buffers), jsonBytes: gzip.bytesWritten };
}
