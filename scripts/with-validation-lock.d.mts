export type ValidationLane = 'test' | 'checks';

export type ValidationLockOptions = {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly timeoutSeconds?: number;
  readonly lockPath?: string;
  readonly tmpRoot?: string;
  readonly lane?: ValidationLane;
};

export function validationTmpRoot(env?: NodeJS.ProcessEnv): string;
export function validationLockPath(lane?: ValidationLane): string;
export function runWithValidationLock(options: ValidationLockOptions): Promise<number>;
