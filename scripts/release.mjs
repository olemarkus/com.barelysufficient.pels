#!/usr/bin/env node
// Cuts a PELS release without shell quoting: every git, gh and homey call
// gets its arguments as an array, and the changelog comes from a file.
//
//   npm run release -- start <patch|minor|major> <changelog-file> [--dry-run]
//   npm run release -- finish
//   npm run release -- publish
//
// `start` branches `bump-X.Y.Z` off origin/main, bumps the version and
// changelog, validates, commits, tags locally, pushes the branch and opens the
// PR with rebase auto-merge (main rejects direct pushes). `--dry-run` stops
// before pushing and removes the branch and tag again.
// `finish` waits for that PR to merge, checks origin/main's app.json carries
// the version, and only then pushes the tag, so a tag never outlives a bump
// that did not land. It fast-forwards local main when that is checked out.
// `publish` builds the settings UI and widgets, then runs `homey app publish`
// headless (no version prompt, so no second bump) from a clean checkout of
// origin/main whose version has its tag. The upload lands as a draft build in
// the Homey developer dashboard, where it is promoted to Test and Live.
//
// `homey app version --commit` is not used: it builds its git commit through a
// shell without escaping, so a straight double quote in the changelog breaks it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEVELS = ["patch", "minor", "major"];
const BUMP_FILES = ["app.json", ".homeycompose/app.json", ".homeychangelog.json"];
const MERGE_POLL_MS = 30_000;
const MERGE_TIMEOUT_MS = 90 * 60_000;

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const run = (cmd, args, options = {}) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...options });
};

const read = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

const succeeds = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const versionAt = (ref) => JSON.parse(read("git", ["show", `${ref}:app.json`])).version;

const increment = (version, level) => {
  const [major, minor, patch] = version.split(".").map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

const compareVersions = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
};

const releaseTags = () => read("git", ["tag", "--list", "v*"])
  .split("\n")
  .map((tag) => tag.slice(1))
  .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
  .sort(compareVersions);

const remoteHasTag = (tag) => read("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) !== "";

const requireCleanTree = () => {
  if (read("git", ["status", "--porcelain"]) !== "") fail("the working tree has changes; commit or stash them first");
};

const fetchOrigin = () => run("git", ["fetch", "origin", "main", "--tags"]);

const withTempFile = (text, use) => {
  const dir = mkdtempSync(join(tmpdir(), "pels-release-"));
  const file = join(dir, "message.txt");
  writeFileSync(file, text);
  try {
    return use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const start = (level, changelogFile, dryRun) => {
  if (!LEVELS.includes(level)) fail(`level must be one of ${LEVELS.join(", ")}`);
  if (!changelogFile) fail("pass the changelog as a file: start <level> <changelog-file>");
  const changelog = readFileSync(changelogFile, "utf8").trim();
  if (changelog.length < 20) fail(`${changelogFile} holds no changelog text`);

  requireCleanTree();
  fetchOrigin();
  const current = versionAt("origin/main");
  const latestTag = releaseTags().at(-1);
  // A pushed tag ahead of main means an earlier bump never landed; cutting
  // from here would reuse its version over a published release.
  if (latestTag && compareVersions(latestTag, current) > 0) {
    fail(`tag v${latestTag} is ahead of origin/main's app.json (${current}); land that bump first`);
  }
  const next = increment(current, level);
  const tag = `v${next}`;
  const branch = `bump-${next}`;
  if (succeeds("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]) || remoteHasTag(tag)) {
    fail(`tag ${tag} already exists`);
  }
  if (succeeds("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) fail(`branch ${branch} already exists`);

  const startBranch = read("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  run("git", ["switch", "-c", branch, "origin/main"]);
  run("homey", ["app", "version", next, "--changelog", changelog]);
  run("homey", ["app", "validate"]);
  const changed = [
    ...read("git", ["diff", "--name-only"]).split("\n"),
    ...read("git", ["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ].filter(Boolean);
  const unexpected = changed.filter((file) => !BUMP_FILES.includes(file));
  if (unexpected.length > 0) fail(`the bump changed more than the version files: ${unexpected.join(", ")}`);
  run("git", ["add", ...BUMP_FILES]);
  withTempFile(`Bump version to ${tag}\n\nChangelog: ${changelog}\n`, (file) => run("git", ["commit", "-F", file]));
  withTempFile(`${changelog}\n`, (file) => run("git", ["tag", "-a", tag, "-F", file]));

  if (dryRun) {
    console.log(`\nDry run: ${branch} and ${tag} were built locally; removing them.`);
    run("git", ["switch", startBranch === "HEAD" ? "--detach" : startBranch, ...(startBranch === "HEAD" ? ["origin/main"] : [])]);
    run("git", ["tag", "-d", tag]);
    run("git", ["branch", "-D", branch]);
    return;
  }

  run("git", ["push", "-u", "origin", branch]);
  run("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `Bump version to ${tag}`, "--body", `Release ${tag}.\n\n${changelog}`]);
  run("gh", ["pr", "merge", branch, "--rebase", "--auto", "--delete-branch"]);
  if (startBranch !== "HEAD") run("git", ["switch", startBranch]);
  console.log(`\nThe ${tag} bump PR merges once CI passes. Then run: npm run release -- finish`);
};

const pendingTag = () => {
  const local = releaseTags();
  const unpushed = local.filter((version) => !remoteHasTag(`v${version}`));
  if (unpushed.length !== 1) {
    fail(unpushed.length === 0
      ? "no local release tag is waiting to be pushed; run start first"
      : `several unpushed release tags: ${unpushed.map((v) => `v${v}`).join(", ")}`);
  }
  return unpushed[0];
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const waitForMerge = async (branch) => {
  const deadline = Date.now() + MERGE_TIMEOUT_MS;
  for (;;) {
    const state = read("gh", ["pr", "view", branch, "--json", "state", "--jq", ".state"]);
    if (state === "MERGED") return;
    if (state === "CLOSED") fail(`the ${branch} PR was closed without merging`);
    if (Date.now() > deadline) fail(`the ${branch} PR has not merged after ${MERGE_TIMEOUT_MS / 60_000} minutes`);
    console.log(`${new Date().toLocaleTimeString()} ${branch} is ${state}; checking again in ${MERGE_POLL_MS / 1000} s`);
    await sleep(MERGE_POLL_MS);
  }
};

const finish = async () => {
  const version = pendingTag();
  const tag = `v${version}`;
  const branch = `bump-${version}`;
  await waitForMerge(branch);
  fetchOrigin();
  const landed = versionAt("origin/main");
  if (landed !== version) fail(`origin/main's app.json reads ${landed}, not ${version}; the tag stays local`);
  run("git", ["push", "origin", tag]);
  const current = read("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current === "main" && read("git", ["status", "--porcelain"]) === "") run("git", ["merge", "--ff-only", "origin/main"]);
  if (succeeds("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) run("git", ["branch", "-D", branch]);
  console.log(`\n${tag} is on origin/main and its tag is pushed. To publish: npm run release -- publish`);
};

const publish = () => {
  requireCleanTree();
  fetchOrigin();
  if (!succeeds("git", ["diff", "--quiet", "HEAD", "origin/main"])) fail("check out origin/main (or fast-forward main) before publishing");
  const version = versionAt("HEAD");
  if (!remoteHasTag(`v${version}`)) fail(`v${version} has no pushed tag; run finish first`);
  // `homey app publish` copies the app into .homeybuild before it runs
  // `npm run build`, so settings/ and the widget bundles must already be built
  // from this checkout; otherwise an older page ships (as `install-app` does).
  run("npm", ["run", "build:settings"]);
  run("npm", ["run", "build:widgets"]);
  // Headless skips the version prompt (its default would bump again) and
  // fails rather than asking if the changelog entry is missing.
  run("homey", ["app", "publish"], { env: { ...process.env, HOMEY_HEADLESS: "1" } });
};

const [command, ...rest] = process.argv.slice(2);
if (command === "start") {
  const positional = rest.filter((arg) => arg !== "--dry-run");
  start(positional[0], positional[1], rest.includes("--dry-run"));
} else if (command === "finish") {
  await finish();
} else if (command === "publish") {
  publish();
} else {
  fail("usage: npm run release -- start <patch|minor|major> <changelog-file> [--dry-run] | finish | publish");
}
