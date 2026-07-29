export const RUNTIME_PATHS: readonly string[];
export const SETTINGS_UI_UNIT_PATHS: readonly string[];
export const MANIFEST_PATHS: readonly string[];
export const RUNTIME_TEST_WIRING_PATHS: readonly string[];
export const SETTINGS_UI_TEST_WIRING_PATHS: readonly string[];

export type ChangeImpact = {
  readonly runtime: boolean;
  readonly settingsUi: boolean;
  readonly browserRisk: boolean;
  readonly docs: boolean;
  readonly playwrightFull: boolean;
  readonly e2eSpecs: readonly string[];
};

export function matchesAnyPath(files: readonly string[], patterns: readonly string[]): boolean;
export function normalizeRepositoryFiles(files: readonly string[], cwd?: string): string[];
export function selectMatchingPaths(files: readonly string[], patterns: readonly string[]): string[];
export function classifyChangeImpact(files: readonly string[]): ChangeImpact;
