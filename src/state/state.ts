import fs from 'node:fs';
import { z } from 'zod';
import { readJson, writeJson } from '../core/fs.js';

export const STAGES = [
  'analyze',
  'design',
  'scenarios',
  'generate',
  'test',
  'triage',
  'file',
  'report',
] as const;
export type Stage = (typeof STAGES)[number];

const StageRecordSchema = z.object({
  completedAt: z.string(),
  /** Hash of the inputs the stage consumed; a changed hash means the output is stale. */
  inputHash: z.string().optional(),
});

const RunRecordSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  scope: z.record(z.string(), z.string()).default({}),
  completedStages: z.array(z.enum(STAGES)).default([]),
  status: z.enum(['running', 'completed', 'failed']),
  error: z.string().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

const FiledBugSchema = z.object({
  fingerprint: z.string(),
  title: z.string(),
  taskId: z.string().optional(),
  url: z.string().optional(),
  firstSeenRun: z.string(),
  lastSeenRun: z.string(),
});
export type FiledBug = z.infer<typeof FiledBugSchema>;

export const QaStateSchema = z.object({
  version: z.literal(1),
  stages: z.partialRecord(z.enum(STAGES), StageRecordSchema).default({}),
  /** Per-page hash of the inputs used when that page's scenarios were generated. */
  scenarioInputs: z.record(z.string(), z.string()).default({}),
  /** Per-spec-file hash of the scenarios used to generate it. */
  generatedSpecs: z.record(z.string(), z.string()).default({}),
  runs: z.array(RunRecordSchema).default([]),
  bugs: z.record(z.string(), FiledBugSchema).default({}),
});
export type QaState = z.infer<typeof QaStateSchema>;

/** Small persistent store for `.qa/state.json`. Every mutation is written immediately so runs can resume. */
export class StateStore {
  readonly data: QaState;

  constructor(private readonly file: string) {
    this.data = readJson(file, QaStateSchema) ?? QaStateSchema.parse({ version: 1 });
  }

  save(): void {
    writeJson(this.file, this.data);
  }

  markStage(stage: Stage, inputHash?: string): void {
    this.data.stages[stage] = { completedAt: new Date().toISOString(), inputHash };
    this.save();
  }

  isStageFresh(stage: Stage, inputHash: string): boolean {
    return this.data.stages[stage]?.inputHash === inputHash;
  }

  startRun(scope: Record<string, string>): RunRecord {
    const id = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const record: RunRecord = {
      id,
      startedAt: new Date().toISOString(),
      scope,
      completedStages: [],
      status: 'running',
    };
    this.data.runs.push(record);
    this.save();
    return record;
  }

  /** The most recent run that did not finish, if any. */
  resumableRun(): RunRecord | undefined {
    const last = this.data.runs.at(-1);
    return last && last.status !== 'completed' ? last : undefined;
  }

  latestRun(): RunRecord | undefined {
    return this.data.runs.at(-1);
  }

  completeRunStage(run: RunRecord, stage: Stage): void {
    if (!run.completedStages.includes(stage)) run.completedStages.push(stage);
    this.save();
  }

  finishRun(run: RunRecord, status: 'completed' | 'failed', error?: string): void {
    run.status = status;
    run.finishedAt = new Date().toISOString();
    if (error) run.error = error;
    this.save();
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }
}
