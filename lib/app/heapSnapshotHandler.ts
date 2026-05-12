import path from 'node:path';
import v8 from 'node:v8';
import type { Logger as PinoLogger } from '../logging/logger';

const DEFAULT_DIR = '/tmp';

export type InstallHeapSnapshotHandlerParams = {
  logger: PinoLogger;
  dir?: string;
};

const formatTimestamp = (now: Date): string => now.toISOString().replace(/[:.]/g, '-');

const writeSnapshot = (params: InstallHeapSnapshotHandlerParams): void => {
  const dir = params.dir ?? DEFAULT_DIR;
  const filePath = path.join(dir, `pels-heap-${formatTimestamp(new Date())}.heapsnapshot`);
  params.logger.info({ event: 'heap_snapshot_writing', filePath });
  try {
    const written = v8.writeHeapSnapshot(filePath);
    params.logger.info({ event: 'heap_snapshot_written', filePath: written });
  } catch (err) {
    params.logger.error({ event: 'heap_snapshot_failed', filePath, err });
  }
};

export const installHeapSnapshotHandler = (
  params: InstallHeapSnapshotHandlerParams,
): (() => void) => {
  const handler = (): void => writeSnapshot(params);
  process.on('SIGUSR2', handler);
  params.logger.info({
    event: 'heap_snapshot_armed',
    signal: 'SIGUSR2',
    hint: 'kill -USR2 <pid> to dump a heap snapshot',
  });
  return () => {
    process.off('SIGUSR2', handler);
  };
};
