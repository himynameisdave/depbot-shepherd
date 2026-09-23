# 🐑 depbot-shepherd

A reusable GitHub Actions workflow that reviews open Dependabot PRs with Codex and merges the ones that pass an explicit safety policy. Written in TypeScript and run with Bun.

The consuming repository owns the schedule. This repository owns discovery, rebase requests, review evidence, the Codex invocation, merge policy, and reporting. No scripts or dependencies need to be copied into your application.

## Set it up

1. Add an `OPENAI_API_KEY` Actions secret in the repository you want to shepherd.
2. Ensure Dependabot is configured and PRs run meaningful CI. Configure branch protection or a ruleset with required checks and **Require branches to be up to date before merging**. The workflow respects required reviews and other merge restrictions; it does not bypass them or approve PRs.
3. Copy [examples/daily.yml](examples/daily.yml) into that repository as `.github/workflows/dependabot-shepherd.yml`.
4. Run it manually first. Manual runs default to dry-run: inspect the Actions job summary before enabling unattended merges. The example's daily schedule enables real merges.

Minimal manual caller:

```yaml
name: Dependabot shepherd
on:
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  checks: read
  statuses: read
  actions: read
jobs:
  shepherd:
    uses: himynameisdave/depbot-shepherd/.github/workflows/shepherd.yml@main
    with:
      dry-run: true
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

This is a **reusable workflow**, so `uses` belongs directly under a job, not inside `steps`. A caller cannot add its own steps to that job. GitHub schedules run from the caller's default branch and interpret cron in UTC; `base-branch` selects which branch's Dependabot PRs to process.

While this project is being developed, `@main` tracks the current implementation. For an immutable deployment, use the same full commit SHA in both places:

```yaml
jobs:
  shepherd:
    uses: himynameisdave/depbot-shepherd/.github/workflows/shepherd.yml@<full-commit-sha>
    with:
      source-ref: <full-commit-sha>
      dry-run: false
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

`source-ref` is necessary because a reusable workflow's normal checkout would fetch the **caller** repository. We explicitly fetch this repository's implementation, resolve its commit once, and use that exact commit in every job. There is no npm publishing or Marketplace registration step.

## What a run does

1. Find open, non-draft Dependabot PRs targeting the selected branch, excluding the skip label. Queue the oldest PR numbers first and process at most one at a time. GitHub controls matrix scheduling, so exact execution order is not guaranteed.
2. Compare each PR with the current base. Ask Dependabot to rebase if behind, or recreate if conflicting, then wait for a new head and green CI. Dependabot's push triggers its usual PR workflows.
3. Check out that exact head without persisted credentials. Collect the PR diff, embedded release notes, CI results, and best-effort upstream GitHub comparisons.
4. Run Codex through the official `openai/codex-action` in a read-only sandbox using its `drop-sudo` protection and API proxy. Codex inspects repository usage and returns structured JSON. It does not install dependencies, run repository scripts, fix code, or merge anything.
5. Re-fetch the PR, compare head and base, and apply the deterministic policy. Only merge if the PR is still eligible, CI is green, the branch is clean and current, the version bump is permitted, and the review accepts it. The GitHub merge API checks the reviewed head SHA atomically.
6. Leave one verdict comment per head SHA, and publish results in the Actions summary and short-lived JSON artifacts. Pre-review skips (such as failed CI) appear in the summary. Failed review jobs and missing artifacts make the report fail.

CI failures, breaking changes, and ambiguous updates stay open for a human. This version does not repair failed builds or edit dependency PRs.

## Inputs

| Input                    | Default               | Purpose                                                                                                                     |
| ------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `base-branch`            | Caller default branch | Only process PRs targeting this branch.                                                                                     |
| `dry-run`                | `true`                | No comments, rebase requests, or merges; eligible PRs still incur review usage. Behind/conflicting PRs skip without review. |
| `pr`                     | Empty                 | Restrict to one open, eligible PR number.                                                                                   |
| `max-auto-merge`         | `minor`               | `patch`, `minor`, or `major`. Unknown versions always skip.                                                                 |
| `merge-method`           | `squash`              | `squash`, `merge`, or `rebase`; enable the chosen method in repository settings.                                            |
| `skip-label`             | `shepherd:skip`       | PR opt-out label; checked again after review.                                                                               |
| `rebase-wait-minutes`    | `10`                  | Maximum wait for Dependabot's new commit.                                                                                   |
| `ci-wait-minutes`        | `30`                  | Maximum wait for checks.                                                                                                    |
| `model`                  | Empty                 | Use Codex's default model, or supply an available model ID.                                                                 |
| `reasoning-effort`       | `high`                | Codex reasoning effort, supported by the chosen model.                                                                      |
| `codex-version`          | `0.156.1`             | Version of Codex CLI and its API proxy.                                                                                     |
| `review-timeout-minutes` | `20`                  | Maximum duration of the review action, including setup.                                                                     |
| `source-ref`             | `main`                | Ref of this repository's implementation; match the workflow reference.                                                      |

Each PR job has a 90-minute overall timeout, including setup, rebase, CI, review, and reporting. Keep configured waits within that budget. Discovery supports up to GitHub's 256-job matrix limit and fails visibly above it; use `pr` to narrow the run.

## Tokens and permissions

`OPENAI_API_KEY` is required for review and is passed only to the official Codex Action. This first version supports API-key authentication, not a copied ChatGPT `auth.json` or token-refresh writeback.

By default, GitHub operations use the caller's `GITHUB_TOKEN`. Merges made with that token generally **do not trigger downstream workflows**. If post-merge CI, deployment, or other event-driven automation must run, supply `SHEPHERD_GITHUB_TOKEN` using a GitHub App installation token or a fine-grained PAT scoped to the consuming repository:

- Contents: read/write.
- Pull requests: read/write.
- Checks and commit statuses: read.
- Workflows: write if the PR changes workflow files and the token requires that permission.

The reusable workflow also needs Actions read permission to download its result artifacts. A caller's permission ceiling must allow the job permissions declared above, even for a dry run. Organization action allowlists must permit this repository, the pinned GitHub Actions, Bun setup, and the official Codex Action.

PR checkouts never persist credentials. GitHub tokens are passed only to deterministic CLI steps, and no caller dependencies or scripts execute in the privileged orchestration steps. Only same-repository PRs authored by Dependabot are eligible.

## Merge policy and limits

The model can withhold a merge; it cannot override these checks:

- Valid verdict with a non-empty summary and evidence of checks performed.
- `decision: merge`, risk below `high`, and confidence above `low`.
- Every parsed update within the configured version ceiling. Incomplete groups, prereleases, downgrades, equal versions, and unrecognized versions require a human.
- No failing or pending CI checks, and at least one actual successful check. All-skipped or all-neutral CI is insufficient.
- GitHub reports both `MERGEABLE` and `CLEAN`.
- PR remains open, non-draft, same-repository, on the configured base, and without the skip label.
- Head and base remain unchanged after review; the final merge request pins the reviewed head SHA.

Use GitHub's required-check and strict up-to-date rules as the final authority. The merge API can atomically compare the head SHA, but not the base SHA; branch protection closes the final race if the base moves after our last read. Merge queues and required human approvals are not bypassed. Repositories using a merge queue may need a separate integration.

Version classification uses Dependabot's title/body, with repository diffs checked by the reviewer; it is not a package-manager-specific manifest parser. A `0.x` minor increase counts as minor but is called out as potentially breaking in the review prompt. Upstream diffs are best-effort, size-limited, and may be missing. Codex is instructed to skip when the available evidence is insufficient. A review cannot guarantee dependency safety.

## Development

```sh
bun install --frozen-lockfile
bun run validate
bun run format
```

- `src/main.ts`: GitHub CLI orchestration (`discover`, `sync`, `prepare`, `decide`, `report`).
- `src/lib.ts`: version parsing, review contract, checks, policy, and rendering.
- `review/prompt.md` and `review/verdict.schema.json`: reviewer instructions and JSON contract.
- `.github/workflows/shepherd.yml`: public `workflow_call` entry point.
- `tests/fixtures/gh.mjs`: offline GitHub simulator for integration tests.

Uses `@himynameisdave/oxlint-config` (including type-aware rules) and `@himynameisdave/oxfmt-config`. Bun executes the TypeScript directly; consumers do not install this project's development dependencies. CI checks types, lint, formatting, unit tests, and simulated orchestration paths. The manual smoke workflow exercises reusable-workflow discovery on GitHub without API usage or repository mutations.

To add Claude/Anthropic later, implement a review step that writes the same verdict JSON to the path emitted by `prepare`. Keep discovery, GitHub credentials, and merge policy outside the provider integration. Only Codex is wired up today.

Adapted from [davestack PR #67](https://github.com/himynameisdave/davestack/pull/67). References: [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), and [Codex Action](https://github.com/openai/codex-action).
