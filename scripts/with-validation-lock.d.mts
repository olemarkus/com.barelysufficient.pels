export type ValidationLockOptions = {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly timeoutSeconds?: number;
  readonly lockPath?: string;
};

export function validationLockPath(): string;
export function runWithValidationLock(options: ValidationLockOptions): Promise<number>;
