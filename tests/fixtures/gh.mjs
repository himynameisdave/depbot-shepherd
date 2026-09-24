#!/usr/bin/env bun
// A deterministic GitHub CLI double. No network access or real repository mutations.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const file = process.env.FAKE_GITHUB;
const data = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const input = args.includes('--input') || args.includes('--body-file') ? readFileSync(0, 'utf8') : '';
appendFileSync(`${file}.log`, `${JSON.stringify({ args, input })}\n`);
function output(value) {
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
}
if (args[0] === 'pr' && args[1] === 'view') {
  output(data.pr);
} else if (args[0] === 'pr' && args[1] === 'list') {
  output(data.prs ?? [data.pr]);
} else if (args[0] === 'pr' && args[1] === 'diff') {
  output('diff --git a/package.json b/package.json\n-1.0.0\n+1.0.1\n');
} else if (args[0] === 'pr' && args[1] === 'comment') {
  data.comments = `${data.comments ?? ''}\n${input}`;
  writeFileSync(file, JSON.stringify(data));
  output('https://github.com/example/repo/pull/1#comment');
} else if (args.includes('graphql') && args.some((arg) => arg.includes('updatePullRequestBranch'))) {
  if (!args.includes(`head=${data.pr.headRefOid}`) || data.rejectRebase) {
    process.stderr.write('Rebase refused');
    process.exit(1);
  }
  if (data.rebaseHead) {
    data.pr.headRefOid = data.rebaseHead;
    data.pr.mergeStateStatus = 'CLEAN';
    data.behind = 0;
    if (data.rebasedChecks) {
      data.pr.statusCheckRollup = data.rebasedChecks;
    }
    writeFileSync(file, JSON.stringify(data));
  }
  output({ data: { updatePullRequestBranch: { clientMutationId: null } } });
} else if (args.includes('graphql')) {
  if (data.protectionError) {
    process.exit(1);
  }
  output({
    data: {
      repository: {
        ref: {
          branchProtectionRule: data.classicStrict
            ? { requiresStatusChecks: true, requiresStrictStatusChecks: true }
            : null,
        },
      },
    },
  });
} else if (args.some((arg) => arg.includes('/rules/branches/'))) {
  output([
    data.rulesetStrict
      ? [
          {
            type: 'required_status_checks',
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [{ context: 'CI' }],
            },
          },
        ]
      : [],
  ]);
} else if (args.some((arg) => arg.includes('/git/ref/heads/'))) {
  output({ object: { sha: data.baseSha } });
} else if (args.some((arg) => arg.includes('/compare/'))) {
  output({ behind_by: data.behind ?? 0 });
} else if (args.some((arg) => arg.includes('/comments?'))) {
  output(data.comments ?? '');
} else if (args.includes('PUT') && args.some((arg) => arg.endsWith('/merge'))) {
  const body = JSON.parse(input);
  output({ merged: body.sha === data.pr.headRefOid && !data.rejectMerge, message: 'simulated merge' });
} else {
  process.stderr.write(`Unexpected gh invocation: ${JSON.stringify(args)}`);
  process.exit(1);
}
