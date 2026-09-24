import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

type Step = {
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly id?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
};
type Workflow = {
  readonly on: Readonly<Record<string, unknown>>;
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly steps?: readonly Step[];
        readonly strategy?: { readonly 'max-parallel': number };
      }
    >
  >;
};
const workflow = parse(readFileSync('.github/workflows/shepherd.yml', 'utf8')) as Workflow;

describe('reusable workflow contract', () => {
  it('exposes workflow_call and leaves scheduling to the caller', () => {
    expect(workflow.on.workflow_call).toBeDefined();
    expect(workflow.on.schedule).toBeUndefined();
    expect(workflow.jobs.shepherd?.strategy?.['max-parallel']).toBe(1);
  });

  it('pins third-party actions and disables persisted checkout credentials', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses !== undefined) {
          expect(step.uses).toMatch(/@[a-f\d]{40}$/u);
        }
        if (step.uses?.startsWith('actions/checkout')) {
          expect(step.with?.['persist-credentials']).toBe(false);
          expect(step.with?.ref).toBeDefined();
        }
      }
    }
  });

  it('separates the reviewer from GitHub mutation credentials', () => {
    const steps = workflow.jobs.shepherd?.steps ?? [];
    const reviewer = steps.find((step) => step.uses?.startsWith('openai/codex-action'));
    expect(reviewer?.with?.sandbox).toBe('read-only');
    expect(reviewer?.with?.['safety-strategy']).toBe('drop-sudo');
    expect(reviewer?.env?.GH_TOKEN).toBeUndefined();
    expect(reviewer?.with?.['output-schema-file']).toBeDefined();
    expect(reviewer?.with?.['openai-api-key']).toBeDefined();
  });
});

describe('review cost defaults', () => {
  it('pins a cheap default and prevents blank inputs from choosing an implicit model', () => {
    const call = workflow.on.workflow_call as { inputs: Record<string, { default: unknown }> };
    expect(call.inputs.model?.default).toBe('gpt-6-luna');
    expect(call.inputs['reasoning-effort']?.default).toBe('medium');
    const reviewer = workflow.jobs.shepherd?.steps?.find((step) => step.uses?.startsWith('openai/codex-action'));
    expect(reviewer?.with?.model).toContain("|| 'gpt-6-luna'");
    expect(reviewer?.if).toContain("steps.reuse.outputs.reused != 'true'");
  });

  it('only saves explicitly cacheable skips with exact cache keys', () => {
    const steps = workflow.jobs.shepherd?.steps ?? [];
    const save = steps.find((step) => step.uses?.startsWith('actions/cache/save'));
    const restore = steps.find((step) => step.uses?.startsWith('actions/cache/restore'));
    expect(save?.if).toContain("steps.decide.outputs.cacheable == 'true'");
    expect(save?.with?.key).toBe(restore?.with?.key);
    expect(restore?.with?.['restore-keys']).toBeUndefined();
    expect(save?.with?.key).toContain('hashFiles');
  });
});
