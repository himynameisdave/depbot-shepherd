/**
 * Pure helpers for the Dependabot shepherd (no I/O). Everything here is unit-tested in
 * `lib.test.ts`; the CLI in `main.ts` wires these to `gh`, `git`, and `codex`.
 */

export type SemverLevel = 'patch' | 'minor' | 'major' | 'unknown';
export type AutoMergeLevel = 'patch' | 'minor' | 'major';

export type Update = {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly level: SemverLevel;
};

export type ChecksState = 'green' | 'red' | 'pending' | 'none';

export type ChecksSummary = {
  readonly state: ChecksState;
  readonly passing: readonly string[];
  readonly failing: readonly string[];
  readonly pending: readonly string[];
};

/** One entry of `gh pr view --json statusCheckRollup`. Check runs and commit statuses differ in shape. */
export type RollupItem = {
  readonly __typename?: string;
  readonly name?: string;
  readonly context?: string;
  readonly workflowName?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly state?: string;
};

export type Verdict = {
  readonly decision: 'merge' | 'skip';
  readonly risk: 'low' | 'medium' | 'high';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly summary: string;
  readonly findings: readonly string[];
  readonly checks_performed: readonly string[];
};

export type Outcome = 'merged' | 'would-merge' | 'skipped' | 'error';

export type Result = {
  readonly pr: number;
  readonly title: string;
  readonly url: string;
  readonly level: SemverLevel;
  readonly updates: readonly Update[];
  readonly outcome: Outcome;
  readonly reason: string;
  readonly headSha?: string;
  readonly verdict?: Verdict | null;
};

export type CompareRef = {
  readonly owner: string;
  readonly repo: string;
  readonly base: string;
  readonly head: string;
};

const LEVEL_RANK: Record<SemverLevel, number> = { patch: 1, minor: 2, major: 3, unknown: 4 };

/** Strips a leading `v`/`=` and any trailing punctuation Dependabot's prose leaves on a version. */
function cleanVersion(raw: string): string {
  return raw
    .trim()
    .replace(/^[v=]/u, '')
    .replace(/[.,;:)\]]+$/u, '');
}

/** Only plain, increasing numeric versions have an unattended merge classification. */
export function bumpLevel(from: string, to: string): SemverLevel {
  const numeric = /^(?<major>0|[1-9]\d*)(?:\.(?<minor>0|[1-9]\d*))?(?:\.(?<patch>0|[1-9]\d*))?$/u;
  const a = numeric.exec(cleanVersion(from))?.groups;
  const b = numeric.exec(cleanVersion(to))?.groups;
  if (!a || !b) {
    return 'unknown';
  }
  const levels = ['major', 'minor', 'patch'] as const;
  for (const level of levels) {
    const oldPart = Number(a[level] ?? 0);
    const newPart = Number(b[level] ?? 0);
    if (!Number.isSafeInteger(oldPart) || !Number.isSafeInteger(newPart) || newPart < oldPart) {
      return 'unknown';
    }
    if (newPart > oldPart) {
      return level;
    }
  }
  return 'unknown';
}

export function maxLevel(updates: readonly Update[]): SemverLevel {
  let top: SemverLevel = 'patch';
  for (const u of updates) {
    if (LEVEL_RANK[u.level] > LEVEL_RANK[top]) {
      top = u.level;
    }
  }
  return updates.length === 0 ? 'unknown' : top;
}

/** Unclassified updates always need a human, regardless of the configured ceiling. */
export function levelAllowed(level: SemverLevel, ceiling: AutoMergeLevel): boolean {
  if (level === 'unknown') {
    return false;
  }
  return LEVEL_RANK[level] <= LEVEL_RANK[ceiling];
}

export function parseAutoMergeLevel(raw?: string): AutoMergeLevel {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'patch' || value === 'minor' || value === 'major') {
    return value;
  }
  if (value === '') {
    return 'minor';
  }
  throw new Error('MAX_AUTO_MERGE must be patch, minor, or major');
}

// Dependabot prose: "Bumps [lodash](url) from 4.17.20 to 4.17.21." (single dependency),
// "Updates `prisma` from 7.9.0 to 7.10.0" (grouped / multi-dependency), or a plain name.
const UPDATE_RE =
  /(?:Bumps|Updates|bump|Bump)\s+(?:\[(?<linked>[^\]]+)\]\([^)]*\)|`(?<quoted>[^`]+)`|(?<plain>\S+))\s+from\s+(?<from>\S+)\s+to\s+(?<to>\S+)/gu;

/**
 * Extracts every "<name> from <a> to <b>" a Dependabot title/body declares. Deduped by name so the
 * body's per-dependency sections don't double count. Empty when the PR isn't in Dependabot's shape.
 */
export function parseUpdates(title: string, body: string): Update[] {
  const seen = new Map<string, Update>();
  for (const text of [body, title]) {
    for (const match of text.matchAll(UPDATE_RE)) {
      const g = match.groups ?? {};
      const name = g.linked ?? g.quoted ?? g.plain ?? '';
      const from = cleanVersion(g.from ?? '');
      const to = cleanVersion(g.to ?? '');
      // "Bumps the prisma group with 3 updates" never has from/to; "the" can't slip through here
      // because the regex requires " from X to Y", but guard against junk anyway.
      if (name === '' || name === 'the' || from === '' || to === '' || seen.has(name)) {
        continue;
      }
      seen.set(name, { name, from, to, level: bumpLevel(from, to) });
    }
  }
  const updates = [...seen.values()];
  const declared = /\bwith (?<count>\d+) updates?\b/u.exec(`${title} ${body}`)?.groups?.count;
  if (declared !== undefined && Number(declared) !== updates.length) {
    updates.push({ name: '(unparsed group members)', from: '?', to: '?', level: 'unknown' });
  }
  return updates;
}

const COMPARE_RE =
  /https:\/\/github\.com\/(?<owner>[\w.-]+)\/(?<repo>[\w.-]+)\/compare\/(?<range>[^\s)>"<]+)/gu;

/** Upstream `compare` links Dependabot embeds in its "Commits" section, deduped. */
export function extractCompareRefs(body: string): CompareRef[] {
  const out: CompareRef[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(COMPARE_RE)) {
    const g = match.groups ?? {};
    const range = g.range ?? '';
    const [base, head] = range.split('...');
    if (!base || !head || !g.owner || !g.repo) {
      continue;
    }
    const key = `${g.owner}/${g.repo}/${base}...${head}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ owner: g.owner, repo: g.repo, base, head });
  }
  return out;
}

const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const RED = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);

function checkName(item: Readonly<RollupItem>): string {
  const base = item.name ?? item.context ?? 'unnamed check';
  return item.workflowName ? `${item.workflowName} / ${base}` : base;
}

/** Collapses a status-check rollup into one state. Any red check wins; otherwise any pending. */
export function summarizeChecks(rollup: readonly Readonly<RollupItem>[]): ChecksSummary {
  const passing: string[] = [];
  const failing: string[] = [];
  const pending: string[] = [];
  for (const item of rollup) {
    const name = checkName(item);
    // Commit status (StatusContext) carries `state`; a check run carries `status` + `conclusion`.
    const outcome = (item.state ?? item.conclusion ?? '').toUpperCase();
    const status = (item.status ?? '').toUpperCase();
    if (item.state === undefined && status !== '' && status !== 'COMPLETED') {
      pending.push(name);
    } else if (GREEN.has(outcome)) {
      passing.push(name);
    } else if (RED.has(outcome)) {
      failing.push(name);
    } else {
      pending.push(name);
    }
  }
  let state: ChecksState = 'green';
  if (rollup.length === 0) {
    state = 'none';
  } else if (failing.length > 0) {
    state = 'red';
  } else if (pending.length > 0) {
    state = 'pending';
  } else if (!rollup.some((item) => (item.state ?? item.conclusion ?? '').toUpperCase() === 'SUCCESS')) {
    state = 'none';
  }
  return { state, passing, failing, pending };
}

function isDecision(v: unknown): v is Verdict['decision'] {
  return v === 'merge' || v === 'skip';
}

function isRisk(v: unknown): v is Verdict['risk'] {
  return v === 'low' || v === 'medium' || v === 'high';
}

function isConfidence(v: unknown): v is Verdict['confidence'] {
  return v === 'high' || v === 'medium' || v === 'low';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/** Provider-neutral verdict boundary. Invalid or incomplete evidence never authorizes a merge. */
export function parseVerdict(text: string): Verdict | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*(?<json>[\s\S]*?)\s*```$/u.exec(trimmed);
  const candidate = fenced?.groups?.json ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const { decision, risk, confidence, summary } = parsed;
  if (!isDecision(decision) || !isRisk(risk) || !isConfidence(confidence) || typeof summary !== 'string') {
    return null;
  }
  if (
    summary.trim() === ''
    || !Array.isArray(parsed.findings)
    || !parsed.findings.every((v: unknown) => typeof v === 'string')
    || !Array.isArray(parsed.checks_performed)
    || !parsed.checks_performed.every((v: unknown) => typeof v === 'string' && v.trim() !== '')
    || parsed.checks_performed.length === 0
    || Object.keys(parsed).some(
      (key) => !['decision', 'risk', 'confidence', 'summary', 'findings', 'checks_performed'].includes(key),
    )
  ) {
    return null;
  }
  return {
    decision,
    risk,
    confidence,
    summary: summary.trim(),
    findings: stringList(parsed.findings),
    checks_performed: stringList(parsed.checks_performed),
  };
}

export type PolicyInput = {
  readonly verdict: Verdict | null;
  readonly level: SemverLevel;
  readonly ceiling: AutoMergeLevel;
  readonly checks: ChecksState;
  readonly mergeable: string;
  readonly mergeStateStatus: string;
};

export type PolicyDecision = { readonly merge: boolean; readonly reason: string };

/**
 * The deterministic gate between Codex's opinion and `gh pr merge`. Every condition must hold —
 * Codex can only ever *withhold* a merge that policy would allow, never force one it wouldn't.
 */
export function applyPolicy(input: Readonly<PolicyInput>): PolicyDecision {
  const { verdict, level, ceiling, checks, mergeable, mergeStateStatus } = input;
  if (verdict === null) {
    return { merge: false, reason: 'Codex did not return a valid verdict' };
  }
  if (verdict.decision !== 'merge') {
    return { merge: false, reason: `Codex verdict: skip — ${verdict.summary}` };
  }
  if (verdict.risk === 'high') {
    return { merge: false, reason: `Codex rated the risk high — ${verdict.summary}` };
  }
  if (verdict.confidence === 'low') {
    return { merge: false, reason: `Codex confidence too low to auto-merge — ${verdict.summary}` };
  }
  if (!levelAllowed(level, ceiling)) {
    return {
      merge: false,
      reason: `${level} bump exceeds the MAX_AUTO_MERGE ceiling (${ceiling}) — needs a human`,
    };
  }
  if (checks !== 'green') {
    return { merge: false, reason: `CI is ${checks} on the current head` };
  }
  if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') {
    return { merge: false, reason: 'branch has conflicts with the base' };
  }
  if (mergeStateStatus === 'BEHIND') {
    return { merge: false, reason: 'base branch moved during review — will rebase next run' };
  }
  if (mergeStateStatus === 'DRAFT') {
    return { merge: false, reason: 'PR is a draft' };
  }
  if (mergeable !== 'MERGEABLE' || mergeStateStatus !== 'CLEAN') {
    return { merge: false, reason: `mergeability is not clean (${mergeable}/${mergeStateStatus})` };
  }
  return { merge: true, reason: verdict.summary };
}

/** Fills `{{KEY}}` placeholders. Unknown placeholders are left as-is so a typo is visible. */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replaceAll(/\{\{(?<key>\w+)\}\}/gu, (whole, key: string) => vars[key] ?? whole);
}

export function formatUpdates(updates: readonly Update[]): string {
  if (updates.length === 0) {
    return '- (could not parse any "from X to Y" — read pr.md and pr.diff to find out what changed)';
  }
  return updates.map((u) => `- \`${u.name}\`: ${u.from} → ${u.to} (${u.level})`).join('\n');
}

const OUTCOME_ICON: Record<Outcome, string> = {
  'merged': '✅ merged',
  'would-merge': '🧪 would merge (dry run)',
  'skipped': '⏭️ skipped',
  'error': '💥 error',
};

function cell(text: string): string {
  return text
    .replaceAll('|', String.raw`\|`)
    .replaceAll(/\r?\n/gu, ' ')
    .trim();
}

/** Job-summary markdown for the whole run. */
export function renderReport(results: readonly Result[], opts: Readonly<{ dryRun: boolean }>): string {
  const lines: string[] = ['## 🐑 Dependabot shepherd', ''];
  if (opts.dryRun) {
    lines.push('> **Dry run** — nothing was commented, rebased, or merged.', '');
  }
  if (results.length === 0) {
    lines.push('No open Dependabot pull requests. Nothing to do.');
    return `${lines.join('\n')}\n`;
  }
  const counts = new Map<Outcome, number>();
  for (const r of results) {
    counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([k, v]) => `${OUTCOME_ICON[k]}: ${v}`).join(' · ');
  lines.push(summary, '', '| PR | Title | Bump | Outcome | Why |', '| --- | --- | --- | --- | --- |');
  for (const r of [...results].toSorted((a, b) => a.pr - b.pr)) {
    lines.push(
      `| [#${r.pr}](${r.url}) | ${cell(r.title)} | ${r.level} | ${OUTCOME_ICON[r.outcome]}`
        + ` | ${cell(r.reason)} |`,
    );
  }
  const attention = results.filter((r) => r.outcome === 'skipped' || r.outcome === 'error');
  if (attention.length > 0) {
    lines.push('', '### Needs a human', '');
    for (const r of attention) {
      lines.push(`- [#${r.pr}](${r.url}) — ${cell(r.reason)}`);
      for (const f of r.verdict?.findings ?? []) {
        lines.push(`  - ${cell(f)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The PR comment left with Codex's review, carrying a marker so the same head isn't re-commented. */
export function renderVerdictComment(
  input: Readonly<{
    headSha: string;
    verdict: Verdict;
    level: SemverLevel;
    willMerge: boolean;
    reason: string;
    runUrl: string;
    skipLabel: string;
  }>,
): string {
  const { headSha, verdict, level, willMerge, reason, runUrl, skipLabel } = input;
  const lines = [
    verdictMarker(headSha),
    `### 🐑 Dependabot shepherd — ${willMerge ? 'merging' : 'not merging'}`,
    '',
    `**Bump:** ${level} · **Codex verdict:** ${verdict.decision} · **Risk:** ${verdict.risk}`
      + ` · **Confidence:** ${verdict.confidence}`,
    '',
    verdict.summary,
  ];
  if (!willMerge) {
    lines.push('', `**Why not:** ${reason}`);
  }
  if (verdict.findings.length > 0) {
    lines.push('', '**Findings**', ...verdict.findings.map((f) => `- ${f}`));
  }
  if (verdict.checks_performed.length > 0) {
    lines.push(
      '',
      '<details><summary>Checks performed</summary>',
      '',
      ...verdict.checks_performed.map((c) => `- ${c}`),
      '',
      '</details>',
    );
  }
  lines.push(
    '',
    `<sub>Automated review by the <a href="${runUrl}">Dependabot shepherd</a> workflow.`
      + ` Add the <code>${skipLabel}</code> label to keep it off this PR.</sub>`,
  );
  return `${lines.join('\n')}\n`;
}

export function verdictMarker(headSha: string): string {
  return `<!-- dependabot-shepherd:verdict sha=${headSha} -->`;
}

export function rebaseMarker(headSha: string): string {
  return `<!-- dependabot-shepherd:rebase sha=${headSha} -->`;
}

/** True when any comment body already carries the marker (so we don't spam on every daily run). */
export function hasMarker(commentBodies: readonly string[], marker: string): boolean {
  return commentBodies.some((body) => body.includes(marker));
}

/** Trims a unified diff to a byte budget, keeping whole files where possible. */
export function truncateText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }
  const sliced = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return `${sliced}\n\n[... truncated at ${maxBytes} bytes ...]\n`;
}
