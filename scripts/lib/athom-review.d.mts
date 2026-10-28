export function athomReviewChanges(input: {
  baseManifest: Record<string, unknown>;
  headManifest: Record<string, unknown>;
  changedFiles: readonly string[];
}): string[];
