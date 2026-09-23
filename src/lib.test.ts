import { describe, expect, it } from 'bun:test';

import {
  applyPolicy,
  bumpLevel,
  extractCompareRefs,
  hasMarker,
  levelAllowed,
  maxLevel,
  parseAutoMergeLevel,
  parseUpdates,
  parseVerdict,
  renderReport,
  renderTemplate,
  renderVerdictComment,
  summarizeChecks,
  truncateText,
  verdictMarker,
  type Result,
  type Verdict,
} from './lib.ts';

const SINGLE_BODY = `Bumps [zod](https://github.com/colinhacks/zod) from 4.4.3 to 4.5.0.
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/colinhacks/zod/releases">zod's releases</a>.</em></p>
</details>
<details>
<summary>Commits</summary>
<ul>
<li>See full diff in <a href="https://github.com/colinhacks/zod/compare/v4.4.3...v4.5.0">compare view</a></li>
</ul>
</details>`;

const GROUP_BODY = `Bumps the prisma group with 3 updates in the / directory: [prisma](https://github.com/prisma/prisma), [@prisma/client](https://github.com/prisma/prisma) and [@prisma/adapter-pg](https://github.com/prisma/prisma).

Updates \`prisma\` from 7.10.0 to 7.11.0
<details>
<summary>Commits</summary>
<ul>
<li>See full diff in <a href="https://github.com/prisma/prisma/compare/7.10.0...7.11.0">compare view</a></li>
</ul>
</details>

Updates \`@prisma/client\` from 7.10.0 to 7.11.0
<details>
<summary>Commits</summary>
<ul>
<li>See full diff in <a href="https://github.com/prisma/prisma/compare/7.10.0...7.11.0">compare view</a></li>
</ul>
</details>

Updates \`@prisma/adapter-pg\` from 7.10.0 to 7.11.0`;

const VERDICT: Verdict = {
  decision: 'merge',
  risk: 'low',
  confidence: 'high',
  summary: 'Patch release with a docs-only change.',
  findings: [],
  checks_performed: ['read release notes', 'grepped src/ for affected APIs'],
};

describe('bumpLevel behavior', () => {
  it('classifies numeric bumps the way Dependabot does', () => {
    expect(bumpLevel('4.4.3', '4.5.0')).toBe('minor');
    expect(bumpLevel('4.4.3', '4.4.4')).toBe('patch');
    expect(bumpLevel('4.4.3', '5.0.0')).toBe('major');
    expect(bumpLevel('0.7.0', '0.8.0')).toBe('minor');
  });

  it('handles v-prefixes, bare majors (actions), and prerelease tags', () => {
    expect(bumpLevel('v6', 'v7')).toBe('major');
    expect(bumpLevel('6', '6.1')).toBe('minor');
    expect(bumpLevel('7.0.2-beta.1', '7.0.2')).toBe('unknown');
    expect(bumpLevel('1.2.3.', '1.2.4')).toBe('patch');
  });

  it('is unknown for non-numeric versions such as git SHAs', () => {
    expect(bumpLevel('a1b2c3d', 'e4f5a6b')).toBe('unknown');
  });
});

describe('parseUpdates behavior', () => {
  it('parses a single-dependency PR from its body', () => {
    expect(parseUpdates('Bump zod from 4.4.3 to 4.5.0', SINGLE_BODY)).toStrictEqual([
      { name: 'zod', from: '4.4.3', to: '4.5.0', level: 'minor' },
    ]);
  });

  it('parses every member of a grouped PR exactly once', () => {
    const updates = parseUpdates('Bump the prisma group with 3 updates', GROUP_BODY);
    expect(updates.map((u) => u.name)).toStrictEqual(['prisma', '@prisma/client', '@prisma/adapter-pg']);
    expect(updates.every((u) => u.level === 'minor')).toBe(true);
  });

  it('falls back to the title and tolerates an emoji prefix', () => {
    expect(parseUpdates('⬆️ bump actions/checkout from 6 to 7', '')).toStrictEqual([
      { name: 'actions/checkout', from: '6', to: '7', level: 'major' },
    ]);
  });

  it('returns nothing for a PR that is not in Dependabot shape', () => {
    expect(parseUpdates('✨ add passkeys', 'Adds passkey login.')).toStrictEqual([]);
  });
});

describe('maxLevel / levelAllowed / parseAutoMergeLevel', () => {
  it('takes the highest level across updates and treats no updates as unknown', () => {
    expect(
      maxLevel([
        { name: 'a', from: '1', to: '1.1', level: 'minor' },
        { name: 'b', from: '1', to: '2', level: 'major' },
      ]),
    ).toBe('major');
    expect(maxLevel([])).toBe('unknown');
  });

  it('never allows unknown bumps', () => {
    expect(levelAllowed('patch', 'patch')).toBe(true);
    expect(levelAllowed('minor', 'patch')).toBe(false);
    expect(levelAllowed('major', 'minor')).toBe(false);
    expect(levelAllowed('unknown', 'minor')).toBe(false);
    expect(levelAllowed('unknown', 'major')).toBe(false);
  });

  it('defaults an absent ceiling and rejects invalid configuration', () => {
    expect(parseAutoMergeLevel('MAJOR')).toBe('major');
    expect(() => parseAutoMergeLevel('yolo')).toThrow('MAX_AUTO_MERGE');
    expect(parseAutoMergeLevel()).toBe('minor');
  });
});

describe('extractCompareRefs behavior', () => {
  it('dedupes the compare links Dependabot embeds', () => {
    expect(extractCompareRefs(GROUP_BODY)).toStrictEqual([{ owner: 'prisma', repo: 'prisma', base: '7.10.0', head: '7.11.0' }]);
    expect(extractCompareRefs(SINGLE_BODY)).toStrictEqual([{ owner: 'colinhacks', repo: 'zod', base: 'v4.4.3', head: 'v4.5.0' }]);
  });
});

describe('summarizeChecks behavior', () => {
  it('is green only when every check run and status context passed', () => {
    const summary = summarizeChecks([
      { name: 'lint', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'e2e', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', context: 'deploy/preview', state: 'SUCCESS' },
    ]);
    expect(summary.state).toBe('green');
    expect(summary.passing).toStrictEqual(['CI / lint', 'CI / e2e', 'deploy/preview']);
  });

  it('reports red over pending, and pending over green', () => {
    expect(
      summarizeChecks([
        { name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'b', status: 'IN_PROGRESS', conclusion: null },
      ]),
    ).toMatchObject({ state: 'red', failing: ['a'], pending: ['b'] });
    expect(
      summarizeChecks([
        { name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { context: 'b', state: 'PENDING' },
      ]).state,
    ).toBe('pending');
  });

  it('is none when nothing has reported', () => {
    expect(summarizeChecks([]).state).toBe('none');
  });
});

describe('parseVerdict behavior', () => {
  it('accepts a bare or fenced JSON object and normalises the lists', () => {
    const raw = JSON.stringify({ ...VERDICT, findings: ['x', ''] });
    expect(parseVerdict(raw)?.findings).toStrictEqual(['x']);
    expect(parseVerdict(`\`\`\`json\n${raw}\n\`\`\``)?.decision).toBe('merge');
  });

  it('rejects anything off-schema', () => {
    expect(parseVerdict('not json')).toBeNull();
    expect(parseVerdict('[]')).toBeNull();
    expect(parseVerdict(JSON.stringify({ ...VERDICT, decision: 'ship it' }))).toBeNull();
    expect(parseVerdict(JSON.stringify({ ...VERDICT, summary: 42 }))).toBeNull();
  });
});

describe('applyPolicy behavior', () => {
  const base = {
    verdict: VERDICT,
    level: 'minor' as const,
    ceiling: 'minor' as const,
    checks: 'green' as const,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  };

  it('merges only when every gate is open', () => {
    expect(applyPolicy(base)).toStrictEqual({ merge: true, reason: VERDICT.summary });
  });

  it('never merges without a verdict, on a skip, on high risk, or on low confidence', () => {
    expect(applyPolicy({ ...base, verdict: null }).merge).toBe(false);
    expect(applyPolicy({ ...base, verdict: { ...VERDICT, decision: 'skip' } }).merge).toBe(false);
    expect(applyPolicy({ ...base, verdict: { ...VERDICT, risk: 'high' } }).merge).toBe(false);
    expect(applyPolicy({ ...base, verdict: { ...VERDICT, confidence: 'low' } }).merge).toBe(false);
  });

  it('enforces the semver ceiling regardless of the verdict', () => {
    expect(applyPolicy({ ...base, level: 'major' }).reason).toContain('MAX_AUTO_MERGE');
    expect(applyPolicy({ ...base, level: 'major', ceiling: 'major' }).merge).toBe(true);
  });

  it('requires green CI and a clean, up-to-date branch', () => {
    expect(applyPolicy({ ...base, checks: 'pending' }).merge).toBe(false);
    expect(applyPolicy({ ...base, mergeable: 'CONFLICTING' }).merge).toBe(false);
    expect(applyPolicy({ ...base, mergeStateStatus: 'BEHIND' }).reason).toContain('moved');
    expect(applyPolicy({ ...base, mergeStateStatus: 'DRAFT' }).merge).toBe(false);
  });
});

describe('rendering', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(renderTemplate('#{{PR_NUMBER}} {{NOPE}}', { PR_NUMBER: '7' })).toBe('#7 {{NOPE}}');
  });

  it('renders the report table and the needs-a-human section', () => {
    const results: Result[] = [
      {
        pr: 2,
        title: 'Bump b',
        url: 'u2',
        level: 'major',
        updates: [],
        outcome: 'skipped',
        reason: 'too | risky',
        verdict: { ...VERDICT, findings: ['uses removed API'] },
      },
      { pr: 1, title: 'Bump a', url: 'u1', level: 'patch', updates: [], outcome: 'merged', reason: 'fine' },
    ];
    const md = renderReport(results, { dryRun: false });
    expect(md).toContain('✅ merged: 1');
    expect(md.indexOf('[#1]')).toBeLessThan(md.indexOf('[#2]'));
    expect(md).toContain(String.raw`too \| risky`);
    expect(md).toContain('### Needs a human');
    expect(md).toContain('  - uses removed API');
    expect(renderReport([], { dryRun: true })).toContain('Dry run');
  });

  it('stamps the verdict comment with a marker for its head', () => {
    const body = renderVerdictComment({
      headSha: 'abc123',
      verdict: VERDICT,
      level: 'patch',
      willMerge: false,
      reason: 'CI is pending',
      runUrl: 'https://example/run',
      skipLabel: 'shepherd:skip',
    });
    expect(body.startsWith(verdictMarker('abc123'))).toBe(true);
    expect(body).toContain('**Why not:** CI is pending');
    expect(hasMarker([body], verdictMarker('abc123'))).toBe(true);
    expect(hasMarker([body], verdictMarker('def456'))).toBe(false);
  });

  it('truncates oversized diffs with a visible marker', () => {
    expect(truncateText('short', 100)).toBe('short');
    expect(truncateText('x'.repeat(200), 50)).toMatch(/^x{50}\n\n\[\.\.\. truncated at 50 bytes/u);
  });
});

describe('conservative merge gates', () => {
  it.each([
    ['1.2.3', '1.2.3'],
    ['2.0.0', '1.9.9'],
    ['1.2.3', '1.2.2'],
    ['1.2.3', '1.3.0-beta.1'],
    ['123abc', '124def'],
    ['1.2.bad', '1.2.4'],
  ])('requires human review for %s to %s', (from, to) => {
    expect(bumpLevel(from, to)).toBe('unknown');
  });

  it('rejects partially parsed groups', () => {
    const updates = parseUpdates('Bump the npm group with 2 updates', 'Updates `a` from 1.0.0 to 1.0.1');
    expect(maxLevel(updates)).toBe('unknown');
  });

  it('requires at least one successful check, even if everything else is skipped', () => {
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SKIPPED' }]).state).toBe('none');
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'NEUTRAL' }]).state).toBe('none');
  });

  it.each(['UNKNOWN', 'BLOCKED', 'UNSTABLE', 'HAS_HOOKS'])('blocks merge state %s', (mergeStateStatus) => {
    expect(
      applyPolicy({ verdict: VERDICT, level: 'patch', ceiling: 'minor', checks: 'green', mergeable: 'MERGEABLE', mergeStateStatus })
        .merge,
    ).toBe(false);
  });

  it.each([
    { ...VERDICT, findings: null },
    { ...VERDICT, findings: [1] },
    { ...VERDICT, checks_performed: [] },
    { ...VERDICT, checks_performed: [''] },
    { ...VERDICT, summary: '' },
    { ...VERDICT, extra: true },
  ])('rejects invalid verdict evidence: %j', (verdict) => {
    expect(parseVerdict(JSON.stringify(verdict))).toBeNull();
  });
});
