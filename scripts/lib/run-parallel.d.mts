export type Command = {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
};

export type CommandResult = {
  readonly label: string;
  readonly code: number;
};

export type LinePrefixer = {
  readonly push: (chunk: string | Uint8Array) => void;
  readonly flush: () => void;
};

export function createLinePrefixer(
  label: string,
  write: (line: string) => void,
): LinePrefixer;
export function runOne(command: string, args: readonly string[], label: string): Promise<CommandResult>;
export function runBounded(commands: readonly Command[], maxConcurrency?: number): Promise<void>;
export function runParallel(commands: readonly Command[]): Promise<void>;
export function runSequential(commands: readonly Command[]): Promise<void>;
