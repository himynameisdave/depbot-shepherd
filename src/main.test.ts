import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Result } from './lib.ts';

const roots: string[] = [];
const verdict = {
  decision: 'merge',
  risk: 'low',
  confidence: 'high',
  summary: 'Safe patch.',
  findings: [],
  checks_performed: ['Read release notes and package usage.'],
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shepherd-test-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  const checkout = join(root, 'checkout');
  mkdirSync(bin);
  mkdirSync(checkout);
  copyFileSync('tests/fixtures/gh.mjs', join(bin, 'gh'));
  chmodSync(join(bin, 'gh'), 0o755);
  const init = spawnSync('git', ['init', checkout], { encoding: 'utf8' });
  if (init.status !== 0) {
    throw new Error(init.stderr);
  }
  const commit = spawnSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ],
    { cwd: checkout, encoding: 'utf8' },
  );
  if (commit.status !== 0) {
    throw new Error(commit.stderr);
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim();
  const data = {
    baseSha: 'base-sha',
    rejectRebase: false,
    rebasedChecks: null as { name: string; status: string; conclusion: string }[] | null,
    rebaseHead: '',
    rejectMerge: false,
    comments: '',
    pr: {
      number: 1,
      id: 'PR_test',
      title: 'Bump example from 1.0.0 to 1.0.1',
      body: '',
      url: 'https://github.com/example/repo/pull/1',
      state: 'OPEN',
      isDraft: false,
      isCrossRepository: false,
      headRefName: 'dependabot/example',
      headRefOid: head,
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      labels: [] as { name: string }[],
      author: { login: 'app/dependabot' },
      statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    },
  };
  const fake = join(root, 'github.json');
  const save = () => {
    writeFileSync(fake, JSON.stringify(data));
  };
  save();
  const run = (command: string, env: Readonly<Record<string, string>> = {}) =>
    spawnSync(process.execPath, [resolve('src/main.ts'), command, '--pr', '1'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_REPO: 'example/repo',
        BASE_BRANCH: 'main',
        DRY_RUN: 'false',
        MAX_AUTO_MERGE: 'minor',
        MERGE_METHOD: 'squash',
        SKIP_LABEL: 'shepherd:skip',
        TARGET_PR: '',
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_GITHUB: fake,
        SHEPHERD_DIR: state,
        PR_CHECKOUT: checkout,
        GITHUB_OUTPUT: join(root, 'output'),
        GITHUB_STEP_SUMMARY: join(root, 'summary'),
        CI_WAIT_MINUTES: '0',
        REBASE_WAIT_MINUTES: '0',
        ...env,
      },
    });
  const review = () => {
    writeFileSync(join(state, 'pr-1/verdict.json'), JSON.stringify(verdict));
  };
  const result = () => JSON.parse(readFileSync(join(state, 'results/1.json'), 'utf8')) as Result;
  const calls = () =>
    existsSync(`${fake}.log`)
      ? readFileSync(`${fake}.log`, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { args: string[]; input: string })
      : [];
  return { root, state, head, data, save, run, review, result, calls };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('workflow CLI against simulated GitHub', () => {
  it('prepares the exact checkout and submits a merge with the reviewed SHA', () => {
    const f = fixture();
    expect(f.run('sync').status).toBe(0);
    expect(f.run('prepare').status).toBe(0);
    expect(readFileSync(join(f.state, 'pr-1/context/prompt.md'), 'utf8')).toContain(f.head);
    f.review();
    expect(f.run('decide').status).toBe(0);
    expect(f.result().outcome).toBe('merged');
    const merge = f.calls().find((call) => call.args.includes('PUT'));
    expect(JSON.parse(merge?.input ?? '{}')).toStrictEqual({ sha: f.head, merge_method: 'squash' });
  });

  it('never mutates GitHub in dry run', () => {
    const f = fixture();
    expect(f.run('sync', { DRY_RUN: 'true' }).status).toBe(0);
    expect(
      f.calls().some((call) => call.args.includes('graphql') || call.args.some((arg) => arg.includes('/rules/branches/'))),
    ).toBe(false);
    f.review();
    expect(f.run('decide', { DRY_RUN: 'true' }).status).toBe(0);
    expect(f.result().outcome).toBe('would-merge');
    expect(f.calls().some((call) => call.args.includes('comment') || call.args.includes('PUT'))).toBe(false);
  });

  it('rebases directly when GitHub marks the PR behind', () => {
    const f = fixture();
    f.data.pr.mergeStateStatus = 'BEHIND';
    f.data.rebaseHead = 'rebased-sha';
    f.save();
    expect(f.run('sync').status).toBe(0);
    expect(f.calls().some((call) => call.args.some((arg) => arg.includes('updateMethod:REBASE')))).toBe(true);
    expect(f.calls().some((call) => call.args.includes('comment'))).toBe(false);
    expect(readFileSync(join(f.state, 'pr-1/state.json'), 'utf8')).toContain('rebased-sha');
  });

  it('does not request a rebase in dry run', () => {
    const f = fixture();
    f.data.pr.mergeStateStatus = 'BEHIND';
    f.save();
    expect(f.run('sync', { DRY_RUN: 'true' }).status).toBe(0);
    expect(f.result().reason).toContain('dry run');
    expect(f.calls().some((call) => call.args.includes('comment'))).toBe(false);
  });

  it.each(['head', 'base', 'label', 'draft', 'branch', 'author', 'fork', 'closed'])(
    'skips when %s changes after review',
    (change) => {
      const f = fixture();
      expect(f.run('sync').status).toBe(0);
      f.review();
      if (change === 'head') {
        f.data.pr.headRefOid = 'changed';
      }
      if (change === 'base') {
        f.data.baseSha = 'changed';
      }
      if (change === 'label') {
        f.data.pr.labels = [{ name: 'shepherd:skip' }];
      }
      if (change === 'draft') {
        f.data.pr.isDraft = true;
      }
      if (change === 'branch') {
        f.data.pr.baseRefName = 'other';
      }
      if (change === 'author') {
        f.data.pr.author.login = 'dependabot';
      }
      if (change === 'fork') {
        f.data.pr.isCrossRepository = true;
      }
      if (change === 'closed') {
        f.data.pr.state = 'CLOSED';
      }
      f.save();
      expect(f.run('decide').status).toBe(0);
      expect(f.result().outcome).toBe('skipped');
      expect(f.calls().some((call) => call.args.includes('PUT'))).toBe(false);
    },
  );

  it('blocks a merge if CI turns red during review', () => {
    const f = fixture();
    expect(f.run('sync').status).toBe(0);
    f.review();
    f.data.pr.statusCheckRollup = [{ name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }];
    f.save();
    expect(f.run('decide').status).toBe(0);
    expect(f.result().outcome).toBe('skipped');
    expect(f.result().reason).toContain('red');
  });

  it('propagates a missing verdict as an error', () => {
    const f = fixture();
    expect(f.run('sync').status).toBe(0);
    expect(f.run('decide').status).toBe(1);
    expect(f.result().outcome).toBe('error');
  });

  it('reports refused merges as errors rather than success', () => {
    const f = fixture();
    expect(f.run('sync').status).toBe(0);
    f.review();
    f.data.rejectMerge = true;
    f.save();
    f.run('decide');
    expect(f.result().outcome).toBe('error');
    expect(f.run('report').status).toBe(1);
  });

  it('reports jobs that failed before producing any artifact', () => {
    const f = fixture();
    const report = f.run('report', { EXPECTED_PRS: '[1]', SHEPHERD_JOB_RESULT: 'failure' });
    expect(report.status).toBe(1);
    expect(report.stdout).toContain('did not produce a result');
  });

  it('deduplicates verdict comments for the same head', () => {
    const f = fixture();
    expect(f.run('sync').status).toBe(0);
    f.review();
    f.data.pr.mergeStateStatus = 'BLOCKED';
    f.save();
    expect(f.run('decide').status).toBe(0);
    expect(f.run('decide').status).toBe(0);
    expect(f.calls().filter((call) => call.args.includes('comment'))).toHaveLength(1);
  });

  it('filters discovery by the caller branch and rejects malformed target PRs', () => {
    const f = fixture();
    expect(f.run('discover', { BASE_BRANCH: 'release' }).status).toBe(0);
    expect(f.calls()[0]?.args).toContain('release');
    expect(f.run('discover', { TARGET_PR: 'oops' }).status).toBe(1);
  });
});

describe('review cost controls', () => {
  it.each(['Bump example from 1.0.0 to 2.0.0', 'Bump example from abc123 to def456'])(
    'rejects %s before comparing or rebasing',
    (title) => {
      const f = fixture();
      f.data.pr.title = title;
      f.data.pr.mergeStateStatus = 'BEHIND';
      f.save();
      expect(f.run('sync').status).toBe(0);
      expect(f.result().reason).toContain('no model review needed');
      expect(f.calls()).toHaveLength(1);
    },
  );

  it('reuses a matching skip verdict in dry run without allowing a merge', () => {
    const f = fixture();
    expect(f.run('sync').status).toBe(0);
    expect(f.run('prepare').status).toBe(0);
    writeFileSync(join(f.state, 'pr-1/verdict.json'), JSON.stringify({ ...verdict, decision: 'skip' }));
    expect(f.run('decide', { DRY_RUN: 'true' }).status).toBe(0);
    rmSync(join(f.state, 'pr-1/verdict.json'));
    expect(f.run('reuse').stdout).toContain('reused=true');
    expect(f.run('decide', { DRY_RUN: 'true' }).status).toBe(0);
    expect(f.result().outcome).toBe('skipped');
    expect(f.calls().some((call) => call.args.includes('PUT') || call.args.includes('comment'))).toBe(false);
  });

  it.each(['merge', 'bad-key', 'invalid', 'force'])('ignores a %s cache entry', (mode) => {
    const f = fixture();
    expect(f.run('sync').status).toBe(0);
    expect(f.run('prepare').status).toBe(0);
    const key = readFileSync(join(f.state, 'pr-1/review-key.txt'), 'utf8');
    const cached = JSON.stringify({
      key: mode === 'bad-key' ? 'wrong' : key,
      verdict: { ...verdict, decision: mode === 'merge' ? 'merge' : 'skip' },
    });
    writeFileSync(join(f.state, 'pr-1/skip-cache.json'), mode === 'invalid' ? 'invalid JSON' : cached);
    expect(f.run('reuse', { FORCE_REVIEW: String(mode === 'force') }).stdout).toContain('reused=false');
    expect(existsSync(join(f.state, 'pr-1/verdict.json'))).toBe(false);
  });

  it('does not cache a merge verdict, even in dry run', () => {
    const f = fixture();
    expect(f.run('sync').status).toBe(0);
    expect(f.run('prepare').status).toBe(0);
    f.review();
    expect(f.run('decide', { DRY_RUN: 'true' }).status).toBe(0);
    expect(existsSync(join(f.state, 'pr-1/skip-cache.json'))).toBe(false);
  });

  it('keeps keys stable across dry-run changes and invalidates on model and evidence changes', () => {
    const f = fixture();
    expect(f.run('sync').status).toBe(0);
    expect(f.run('prepare').status).toBe(0);
    const key = () => readFileSync(join(f.state, 'pr-1/review-key.txt'), 'utf8');
    const original = key();
    expect(f.run('prepare', { DRY_RUN: 'true' }).status).toBe(0);
    expect(key()).toBe(original);
    expect(f.run('prepare', { REVIEW_MODEL: 'gpt-6-sol' }).status).toBe(0);
    expect(key()).not.toBe(original);
    f.data.pr.body = 'Updated release notes';
    f.save();
    expect(f.run('sync').status).toBe(0);
    expect(f.run('prepare').status).toBe(0);
    expect(key()).not.toBe(original);
  });
});

describe('direct rebasing and branch protection', () => {
  it('allows a PR whose merge state is clean', () => {
    const f = fixture();
    expect(f.run('sync').status).toBe(0);
    f.review();
    expect(f.run('decide', { DRY_RUN: 'true' }).status).toBe(0);
    expect(f.result().outcome).toBe('would-merge');
    expect(f.calls().some((call) => call.args.some((arg) => arg.includes('updatePullRequestBranch')))).toBe(false);
  });

  it('pins the rebase head for a PR blocked as behind', () => {
    const f = fixture();
    f.data.pr.mergeStateStatus = 'BEHIND';
    f.data.rebaseHead = 'new-sha';
    f.save();
    expect(f.run('sync').status).toBe(0);
    const mutation = f.calls().find((call) => call.args.some((arg) => arg.includes('updatePullRequestBranch')));
    expect(mutation?.args).toContain(`head=${f.head}`);
    expect(mutation?.args).toContain('id=PR_test');
    expect(readFileSync(join(f.state, 'pr-1/state.json'), 'utf8')).toContain('new-sha');
  });

  it('never submits a direct rebase in dry run', () => {
    const f = fixture();
    f.data.pr.mergeStateStatus = 'BEHIND';
    f.save();
    expect(f.run('sync', { DRY_RUN: 'true' }).status).toBe(0);
    expect(f.calls().some((call) => call.args.some((arg) => arg.includes('updatePullRequestBranch')))).toBe(false);
    expect(f.result().reason).toContain('would rebase');
  });

  it('leaves conflicts for a human instead of recreating a dependency PR', () => {
    const f = fixture();
    f.data.pr.mergeable = 'CONFLICTING';
    f.save();
    expect(f.run('sync').status).toBe(0);
    expect(f.result().reason).toContain('conflicts');
    expect(f.calls()).toHaveLength(1);
  });

  it('checks CI on the new head after rebasing', () => {
    const f = fixture();
    f.data.pr.mergeStateStatus = 'BEHIND';
    f.data.rebaseHead = 'new-sha';
    f.data.rebasedChecks = [{ name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }];
    f.save();
    expect(f.run('sync').status).toBe(0);
    expect(f.result().headSha).toBe('new-sha');
    expect(f.result().reason).toContain('CI failing');
  });

  it('reports that GITHUB_TOKEN rebases require CI without waiting on suppressed workflows', () => {
    const f = fixture();
    f.data.pr.mergeStateStatus = 'BEHIND';
    f.data.rebaseHead = 'new-sha';
    f.save();
    expect(f.run('sync', { REBASE_TRIGGERS_WORKFLOWS: 'false' }).status).toBe(0);
    expect(f.result().reason).toContain('SHEPHERD_GITHUB_TOKEN');
    expect(f.result().outcome).toBe('skipped');
  });

  it('fails closed when GitHub refuses to rebase', () => {
    const f = fixture();
    f.data.pr.mergeStateStatus = 'BEHIND';
    f.data.rejectRebase = true;
    f.save();
    expect(f.run('sync').status).toBe(1);
    expect(f.result().outcome).toBe('error');
  });

  it('skips an undetermined merge state without requiring protection access', () => {
    const f = fixture();
    f.data.pr.mergeStateStatus = 'UNKNOWN';
    f.save();
    expect(f.run('sync').status).toBe(0);
    expect(f.result().outcome).toBe('skipped');
    expect(f.calls().some((call) => call.args.includes('graphql'))).toBe(false);
  });

  it('stops if a rebase is accepted but does not produce a new head', () => {
    const f = fixture();
    f.data.pr.mergeStateStatus = 'BEHIND';
    f.save();
    expect(f.run('sync').status).toBe(0);
    expect(f.result().reason).toContain('did not produce a rebased head');
  });

  it('rechecks stricter protection added during review', () => {
    const f = fixture();
    f.save();
    expect(f.run('sync').status).toBe(0);
    f.review();
    f.data.pr.mergeStateStatus = 'BEHIND';
    f.save();
    expect(f.run('decide').status).toBe(0);
    expect(f.result().outcome).toBe('skipped');
    expect(f.calls().some((call) => call.args.includes('PUT'))).toBe(false);
  });
});
