// Fails a PR that would send the next Homey build to Athom's manual review,
// unless the owner has accepted that with the `athom-review` label.
//
//   node scripts/check-athom-review.mjs [--report] [<base> [<head>]]
//
// Base and head default to origin/main and HEAD. ATHOM_REVIEW_ACCEPTED=true
// marks the label as present. --report lists the changes without failing, for
// local runs (`npm run athom:review`, the pre-push hook), where the label is
// not known. The findings are also written to $GITHUB_STEP_SUMMARY when set.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { athomReviewChanges } from './lib/athom-review.mjs';

const args = process.argv.slice(2);
const reportOnly = args.includes('--report');
const [baseSha = 'origin/main', headSha = 'HEAD'] = args.filter((arg) => arg !== '--report');

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
const manifestAt = (sha) => JSON.parse(git(['show', `${sha}:app.json`]));

// Compare from where the branch left its base: the base tip may have moved on,
// and its newer changes must not read as this PR's reverted ones.
const forkPoint = git(['merge-base', baseSha, headSha]).trim();
const changes = athomReviewChanges({
  baseManifest: manifestAt(forkPoint),
  headManifest: manifestAt(headSha),
  // -z keeps non-ASCII paths unquoted so the store page patterns match them.
  changedFiles: git(['diff', '--no-renames', '--name-only', '-z', forkPoint, headSha]).split('\0').filter(Boolean),
});
const accepted = process.env.ATHOM_REVIEW_ACCEPTED === 'true';

const report = changes.length === 0
  ? 'No app.json or store page change: the build can release without Athom review.'
  : [
    accepted
      ? 'Athom review accepted with the `athom-review` label. This PR changes:'
      : 'This change sends the next build to Athom manual review. The owner accepts that by adding the `athom-review` label to its PR. It changes:',
    ...changes.map((change) => `- ${change}`),
  ].join('\n');

console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
if (changes.length > 0 && !accepted && !reportOnly) process.exit(1);
