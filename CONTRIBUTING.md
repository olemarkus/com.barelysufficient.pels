# Contributing to PELS

Thank you for taking the time to contribute!

These are guidelines for contributing to PELS, the Homey Pro app for electricity capacity control, hosted at [olemarkus/com.barelysufficient.pels](https://github.com/olemarkus/com.barelysufficient.pels) on GitHub. They are guidelines, not rules. Use your best judgment, and contact olemarkus@gmail.com if you have any questions.

The user documentation is at [pels.barelysufficient.org](https://pels.barelysufficient.org/).

## Before submitting a bug or feature request

* Have you read the error message, or the device's status in PELS?
* Have you searched the [existing issues](https://github.com/olemarkus/com.barelysufficient.pels/issues)?
* Have you updated Homey and PELS to the latest versions?
* Have you checked that the problem is in PELS, rather than in the app that drives the device?
* Have you looked at what's involved in fixing or implementing this?

If you can, investigate the problem and open a pull request with the fix.

## A great bug report contains

* Context – what were you trying to achieve?
* Detailed steps to reproduce the error from scratch. Try isolating the minimal amount of code needed to reproduce the error.
* Any applicable log files or ID's.
* Evidence you've looked into solving the problem and ideally, a theory on the cause and a possible solution.

## A great feature request contains

* The current situation.
* How and why the current situation is problematic.
* A detailed proposal or pull request that demonstrates how the problem could be solved.
* A use case – who needs this feature and why?
* Any caveats.

## A great pull request contains

* Minimal changes. Only submit code relevant to the current issue. Other changes should go in new pull requests.
* Minimal commits. Please squash to a single commit before sending your pull request.
* No conflicts. Please rebase off the latest main before submitting.
* Code conforming to the existing conventions and formats. i.e. Please don't reformat whitespace.
* Passing tests in the test folder (if applicable). Use existing tests as a reference.
* Relevant documentation.

## Speeding up your pull request
Merging pull requests takes time. While we always try to merge your pull request as soon as possible, there are certain things you can do to speed up this process.

* Ask developers to review your code changes and post their feedback.
* Ask users to test your changes and post their feedback.
* Keep your changes to the minimal required amount, and dedicated to one issue/feature only.

## Local CI

* `npm test` (alias of `npm run ci`) runs the static checks (`ci:checks`), the runtime Vitest tiers, and the settings UI suite (build, Vitest unit tests, Playwright layout spec). The pre-commit hook runs only lint-staged and a few extra staged-file checks.
* `npm run ci:full` adds the local Playwright browser matrix and is the closest match to the GitHub Actions workflow.
* The `pre-push` hook runs `ci:checks`, the runtime and settings UI unit tests related to the pushed diff, and `npm run validate` when manifest files change. Browser suites run in CI.
