# 🐑 depbot-shepherd

Let Dependabot open your dependency updates, then let Codex help review and merge them.

**depbot-shepherd checks your open Dependabot pull requests, waits for your tests to pass, and asks Codex to review the changes against your code.** Updates that pass its merge policy can be merged automatically. Anything that needs attention stays open for you.

You can use it in your own GitHub repository by adding one small YAML file and an OpenAI API key. You do not need to fork this project, install Bun, or add a package to your application.

- [Get started](#get-started): try it manually without changing any PRs.
- [Run it every day](#run-it-every-day): enable scheduled reviews and merges.
- [Common questions](#common-questions): skipped PRs, costs, and troubleshooting.
- [Configuration reference](#configuration-reference): all available settings.
- [Advanced setup](#advanced-setup): version pinning, tokens, and merge rules.

## How it fits together

A **GitHub Actions workflow** is a YAML file in your repository's `.github/workflows/` folder. It tells GitHub what to run and when to run it.

A **reusable workflow** is a workflow maintained in another repository. Your YAML file points to it with `uses:`. GitHub then runs it for **your repository**, using the settings and secrets you provide.

With depbot-shepherd:

1. **Dependabot** opens pull requests (PRs) to update your dependencies.
2. **Your existing CI** runs tests and other checks on those PRs.
3. **depbot-shepherd** brings eligible PRs up to date, asks Codex to review them, and merges only when its checks allow it.
4. **You** review anything it skips and can exclude individual PRs whenever you want.

It does not set up Dependabot or your tests for you, and it does not fix failing tests or make application code changes. Codex is the only supported reviewer today; Claude/Anthropic support is planned as a possible future addition.

## Get started

### 1. Check that your repository is ready

You will need:

- A GitHub repository where you can add workflow files and repository secrets. If you do not have access to repository settings, ask a maintainer to help.
- GitHub Actions enabled for that repository.
- Dependabot configured to open dependency update PRs. If you have not set it up yet, follow [GitHub's Dependabot setup guide](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-version-updates).
- An existing workflow that runs tests or other meaningful checks on PRs. This is usually called **CI**, short for continuous integration. depbot-shepherd will not merge a PR with no successful checks.
- An OpenAI API key with access to Codex. Reviews use your OpenAI API account and can incur charges, including during a dry run. This version does not accept a ChatGPT login or subscription credentials.

The repository does not need to use TypeScript or Bun. Those are used to build depbot-shepherd itself.

### 2. Add your OpenAI API key as a secret

A **secret** lets a workflow use a credential without putting its value in your repository's files.

In **your repository** on GitHub:

1. Open **Settings → Secrets and variables → Actions**.
2. Select **New repository secret**.
3. Set the name to **`OPENAI_API_KEY`**.
4. Paste your API key into the secret value and select **Add secret**.

Keep the name exactly as shown. The YAML below refers to that name; you do not paste the key into the YAML. See [GitHub's secret instructions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) if your settings look different.

### 3. Add the workflow file

In **your repository**, create this file:

```text
.github/workflows/dependabot-shepherd.yml
```

You can create it in your editor, or use **Add file → Create new file** on GitHub and enter the entire path above. Paste the following contents:

```yaml
name: Dependabot shepherd

# Adds a "Run workflow" button in GitHub's Actions tab.
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

**Copy this as-is.** Keep `himynameisdave/depbot-shepherd` in the `uses:` line: it points to this project's shared workflow. GitHub automatically supplies your repository as the target.

Commit the file to your repository's **default branch** (usually `main`), or open a PR and merge it there. The manual run button will not appear until the workflow is on the default branch.

What the main sections mean:

| Section              | What it does                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `on`                 | Chooses when to run. This first example runs only when you click the button.                                           |
| `permissions`        | Allows the workflow to read PR checks, report results, and later merge updates. Keep these entries even for a dry run. |
| `jobs.shepherd.uses` | Calls the workflow maintained in this repository.                                                                      |
| `with`               | Supplies settings. `dry-run: true` prevents comments, rebase requests, and merges.                                     |
| `secrets`            | Passes the API key you saved in step 2 to the reviewer.                                                                |

Unlike an individual Action, a reusable workflow goes directly under a job. You do not wrap this `uses:` line in `steps:`.

### 4. Try a dry run

1. Open your repository's **Actions** tab.
2. Select **Dependabot shepherd** in the left sidebar.
3. Select **Run workflow**, choose your default branch, and confirm **Run workflow**.
4. Open the new run. When it finishes, look at its job summaries. For runs with eligible PRs, open the **report** job for the combined results.

A **dry run** lets you see what would happen without changing any PRs. It can still call Codex and use API credits. PRs that need a rebase are skipped because a dry run cannot request one.

Expect one of these results:

| Result                               | Meaning                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Would merge**                      | The PR passed review and policy, but dry-run mode prevented the merge.                     |
| **Skipped**                          | The PR needs attention or is not ready. Read the reason in the summary.                    |
| **Error**                            | A step failed, such as authentication or the review. Open the failed job's logs.           |
| **No open Dependabot pull requests** | There were no eligible PRs for this run. Discovery completed; there was nothing to review. |

### 5. Prepare for automatic merging

Before turning off dry-run mode, configure branch protection or a ruleset for your target branch with **required status checks** and **Require branches to be up to date before merging**. These make GitHub enforce your CI requirements at merge time. See [GitHub's branch protection guide](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

The default merge method is **squash**: GitHub combines a PR's changes into one commit. Make sure **Allow squash merging** is enabled under your repository's **Settings → General → Pull Requests**, or choose another `merge-method` below.

For a manual run that may merge, change this line in your workflow, commit it, and run the workflow again:

```yaml
dry-run: false
```

The workflow respects required human approvals and other repository restrictions. It does not grant approvals or bypass protection rules. To keep a particular PR out of automation, create and apply the **`shepherd:skip`** label to it.

## Run it every day

Once you are happy with the dry-run results, replace your workflow file with the following. It runs daily at **09:17 UTC** and also keeps the manual run button.

**Scheduled runs may merge PRs.** Manual runs default to dry-run mode; clear the dry-run checkbox when you want a manual run to make changes.

```yaml
name: Daily Dependabot shepherd
on:
  schedule:
    - cron: '17 9 * * *' # Daily at 09:17 UTC
  workflow_dispatch:
    inputs:
      dry-run:
        description: Review only, without comments, rebases, or merges
        type: boolean
        default: true
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
      # Scheduled runs merge; manual runs default to dry-run.
      dry-run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry-run }}
      max-auto-merge: minor
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      # Optional: makes merges trigger downstream workflows.
      # SHEPHERD_GITHUB_TOKEN: ${{ secrets.SHEPHERD_GITHUB_TOKEN }}
```

This complete example is also available in [examples/daily.yml](examples/daily.yml).

The `cron` expression sets the schedule, in UTC. GitHub may delay scheduled runs, so treat this as a daily maintenance task rather than an exact appointment. The file must remain on your default branch even if you configure the workflow to review PRs targeting another branch.

To stop scheduled runs, remove the `schedule:` entry or disable the workflow from its Actions page. To keep the schedule but stop changes to PRs, replace the `dry-run:` expression under `with:` with `true`.

## Common questions

### Can I use this with a private repository?

Yes, provided your repository or organization allows the referenced GitHub Actions and reusable workflow. You supply your own API key. Codex reviews repository content through OpenAI, so use it only where that is appropriate for your project.

### Does this cost anything?

Codex reviews use your OpenAI API account. GitHub Actions usage is also subject to your GitHub plan. A dry run can still incur review costs; a run with no eligible PRs does not call Codex.

### How do I keep daily review costs down?

The default is **`gpt-6-luna` with `medium` reasoning**, explicitly selected so a changing Codex default cannot silently select a more expensive model. The review configuration appears in the job summary.

```yaml
with:
  dry-run: true
  model: gpt-6-luna
  reasoning-effort: medium
  pr: '123' # Optional: evaluate one PR before reviewing a whole backlog.
```

Updates above `max-auto-merge`, or with unrecognized versions, skip before any model call. The reviewer is instructed to search narrowly and stop once it finds a reason to skip. There is no automatic escalation to a more expensive model.

Completed **skip** reviews are cached, including during dry runs. A matching cached skip avoids another model call. Changing the PR head, base commit, description, collected evidence, model, reasoning effort, Codex version, policy, or review implementation invalidates it. GitHub may evict or restrict cache access, so reuse is best-effort. Cache failures fall back to a fresh review. Cache entries contain review text, not credentials; treat that text as repository data.

Only negative decisions are reused: a cached verdict can **never authorize a merge**. A previous dry-run result of **Would merge** still requires a new review on the next run. To revisit an unchanged skipped PR, set `force-review: true` temporarily; reset it afterward. Forced reviews bypass both cache reads and writes, so they do not replace the stored skip. To replace a cached decision, delete the corresponding `shepherd-skip-v1-…` entry in GitHub's Actions caches before a normal run.

Model choice and shorter reviews reduce costs but are not dollar or token caps. `review-timeout-minutes` limits elapsed time, not spend. Test a cheaper model on a small dry run to assess its judgments before enabling automatic merges. See [current OpenAI API prices](https://developers.openai.com/api/docs/pricing).

### Why did it skip my PR?

Read the summary for the specific reason. Common causes are failing or pending checks, a branch that needs updating, a required human approval, a major version update, or a review that could not establish enough confidence.

By default, patch updates such as `1.2.3 → 1.2.4` and minor updates such as `1.2.3 → 1.3.0` may merge. Major updates such as `1.2.3 → 2.0.0` stay open. Passing tests alone is not sufficient: the review and the other merge checks must also pass.

Drafts, PRs with the skip label, PRs from other authors, and PRs targeting other branches are excluded. It is normal for a run to merge nothing.

### Why can't I see the Run workflow button?

Check that the file is in `.github/workflows/`, contains `workflow_dispatch:`, and has been committed to your default branch. Also check that Actions is enabled and that you have permission to run workflows. GitHub has a [manual-run walkthrough](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) with screenshots.

### Why does the run fail before it reviews anything?

Check that `OPENAI_API_KEY` is an **Actions repository secret** in your repository and that you copied all the `permissions` entries. If GitHub says an Action or reusable workflow is not allowed, a repository or organization administrator may need to update the Actions policy.

### Why didn't my deployment or post-merge CI run?

GitHub provides the workflow with a built-in `GITHUB_TOKEN`. Merges made using that token generally do not trigger other workflows. If merging should start a deployment or another workflow, configure the optional [GitHub token](#triggering-other-workflows-after-a-merge).

### Can I choose a branch or review just one PR?

Yes. Add settings under the existing `with:` section, for example:

```yaml
with:
  dry-run: true
  base-branch: release
  pr: '123'
  max-auto-merge: patch
```

This reviews only PR #123 if it is an eligible Dependabot PR targeting `release`. Remove `pr` when you want to process all eligible PRs again. Settings under `with:` apply to every run, including scheduled runs.

## Configuration reference

All settings go under `jobs.shepherd.with` in **your** workflow file. You only need to include settings you want to change.

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
| `model`                  | `gpt-6-luna`          | Explicit review model; blank also selects Luna.                                                                             |
| `reasoning-effort`       | `medium`              | Codex reasoning effort, supported by the chosen model.                                                                      |
| `force-review`           | `false`               | Ignore a cached skip and pay for a new review. Leave false for routine daily runs.                                          |
| `codex-version`          | `0.156.1`             | Version of Codex CLI and its API proxy.                                                                                     |
| `review-timeout-minutes` | `20`                  | Maximum duration of the review action, including setup.                                                                     |
| `source-ref`             | `main`                | Ref of this repository's implementation; match the workflow reference.                                                      |

Each PR job has a 90-minute overall timeout, including setup, rebase, CI, review, and reporting. Keep configured waits within that budget. Discovery supports up to GitHub's 256-job matrix limit and fails visibly above it; use `pr` to narrow the run.

## Advanced setup

### Choosing a fixed version

The getting-started examples use `@main`, which follows ongoing changes to this project. To keep using a fixed version until you explicitly upgrade, choose a full commit SHA from [this repository's commit history](https://github.com/himynameisdave/depbot-shepherd/commits/main) and use it in **both** places below.

This is a replacement for the `jobs:` section in the getting-started example; keep that example's `on:` and `permissions:` sections. Replace both `<full-commit-sha>` placeholders with the same actual SHA:

```yaml
jobs:
  shepherd:
    uses: himynameisdave/depbot-shepherd/.github/workflows/shepherd.yml@<full-commit-sha>
    with:
      source-ref: <full-commit-sha>
      dry-run: true
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

The ref after `@` selects the workflow definition. `source-ref` selects this repository's TypeScript implementation. The workflow resolves that implementation to one commit for all jobs in a run. Keep the two references aligned when upgrading.

### Triggering other workflows after a merge

You only need an additional GitHub token if you want mutations to trigger other workflows or your setup requires a separate identity. The default `GITHUB_TOKEN` is supplied automatically; you do not create it yourself.

For the optional token, use a GitHub App installation token or a fine-grained personal access token (PAT) scoped to your repository with:

- Contents: read/write.
- Pull requests: read/write.
- Checks and commit statuses: read.
- Workflows: write if the PR changes workflow files and the token requires that permission.

Save the token as an Actions repository secret named `SHEPHERD_GITHUB_TOKEN`, using the same process as for the API key. Then pass it alongside your API key:

```yaml
secrets:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  SHEPHERD_GITHUB_TOKEN: ${{ secrets.SHEPHERD_GITHUB_TOKEN }}
```

A PAT expires according to its settings and must be replaced when necessary. GitHub App installation tokens are short-lived; an App-based setup should generate a fresh token before calling the reusable workflow.

### How review and merging are separated

The workflow asks Dependabot to rebase outdated PRs or recreate conflicting ones, then waits for CI on the new commit. It checks out the exact commit and gathers the PR diff, embedded release notes, check results, and best-effort upstream comparisons.

Codex runs through the official `openai/codex-action` in a read-only sandbox with `drop-sudo` protection and an API proxy. It returns a structured verdict. Separate TypeScript code rechecks the PR and decides whether to ask GitHub to merge.

The API key is passed only to the Codex Action. GitHub tokens are passed only to the orchestration steps. PR checkouts do not persist credentials, and those orchestration steps do not install or execute your repository's scripts.

Eligible PRs are queued by oldest PR number and processed at most one at a time. GitHub controls matrix scheduling, so exact execution order is not guaranteed. Review comments are posted once per head commit; skips before review appear in the summary. Results are also saved as downloadable JSON artifacts for seven days.

### Detailed merge policy

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

- `src/main.ts`: GitHub CLI orchestration (`discover`, `sync`, `prepare`, `reuse`, `decide`, `report`).
- `src/lib.ts`: version parsing, review contract, checks, policy, and rendering.
- `review/prompt.md` and `review/verdict.schema.json`: reviewer instructions and JSON contract.
- `.github/workflows/shepherd.yml`: public `workflow_call` entry point.
- `tests/fixtures/gh.mjs`: offline GitHub simulator for integration tests.

Uses `@himynameisdave/oxlint-config` (including type-aware rules) and `@himynameisdave/oxfmt-config`. Bun executes the TypeScript directly; consumers do not install this project's development dependencies. CI checks types, lint, formatting, unit tests, and simulated orchestration paths. The manual smoke workflow exercises reusable-workflow discovery on GitHub without API usage or repository mutations.

To add Claude/Anthropic later, implement a review step that writes the same verdict JSON to the path emitted by `prepare`. Keep discovery, GitHub credentials, and merge policy outside the provider integration. Only Codex is wired up today.

Adapted from [davestack PR #67](https://github.com/himynameisdave/davestack/pull/67). References: [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), and [Codex Action](https://github.com/openai/codex-action).
