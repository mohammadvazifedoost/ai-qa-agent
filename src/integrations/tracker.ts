import type { QaConfig } from '../config/schema.js';
import { ClickUpClient, PRIORITY, type Fetch } from './clickup.js';
import { JiraClient } from './jira.js';

export type TrackerKind = 'clickup' | 'jira';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export class FilingUnavailable extends Error {
  constructor(
    readonly status: 'not-configured' | 'missing-token',
    message: string,
  ) {
    super(message);
  }
}

export interface NewBug {
  title: string;
  markdown: string;
  /** Tracker labels/tags in addition to the configured ones. */
  labels: string[];
  severity: Severity;
}

/** What filing, the dashboard and `doctor` need from a bug tracker. */
export interface IssueTracker {
  readonly kind: TrackerKind;
  /** Product name for UI text: "ClickUp", "Jira". */
  readonly name: string;
  /** What one item is called there: "task" (ClickUp) or "issue" (Jira). */
  readonly noun: 'task' | 'issue';
  readonly attachEvidence: boolean;
  /** Verify credentials + destination; returns a human description of where bugs go. */
  describeTarget(): Promise<string>;
  create(bug: NewBug): Promise<{ id: string; url?: string }>;
  comment(id: string, text: string): Promise<void>;
  attach(id: string, file: string): Promise<void>;
  exists(id: string): Promise<{ exists: boolean; url?: string; status?: string }>;
}

/**
 * Which tracker a project uses: `tracker` when set, otherwise the only configured one.
 * (The config schema rejects having both without `tracker`.)
 */
export function trackerKind(config: QaConfig): TrackerKind | null {
  if (config.tracker) return config.tracker;
  if (config.jira) return 'jira';
  if (config.clickup) return 'clickup';
  return null;
}

/**
 * Static facts about the configured tracker (or the one named by `kind`), without touching the
 * network or secrets.
 */
export function trackerInfo(
  config: QaConfig,
  env: NodeJS.ProcessEnv = process.env,
  kind: TrackerKind | null = trackerKind(config),
): {
  kind: TrackerKind | null;
  name: string;
  noun: 'task' | 'issue';
  credentialsPresent: boolean;
  /** Names (never values) of the environment variables that still need to be set. */
  missingEnv: string[];
  target: string | null;
} {
  if (kind === 'jira' && config.jira) {
    const j = config.jira;
    const missingEnv = [
      ...(env[j.tokenEnv] ? [] : [j.tokenEnv]),
      ...((j.email ?? env[j.emailEnv]) ? [] : [j.emailEnv]),
    ];
    return {
      kind,
      name: 'Jira',
      noun: 'issue',
      credentialsPresent: missingEnv.length === 0,
      missingEnv,
      target: `project ${j.projectKey}`,
    };
  }
  if (kind === 'clickup' && config.clickup) {
    const missingEnv = env[config.clickup.tokenEnv] ? [] : [config.clickup.tokenEnv];
    return {
      kind,
      name: 'ClickUp',
      noun: 'task',
      credentialsPresent: missingEnv.length === 0,
      missingEnv,
      target: `list ${config.clickup.listId}`,
    };
  }
  return {
    kind: null,
    name: 'Bug tracker',
    noun: 'task',
    credentialsPresent: false,
    missingEnv: [],
    target: null,
  };
}

export function createTracker(
  config: QaConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: Fetch,
  kind: TrackerKind | null = trackerKind(config),
): IssueTracker {
  if (kind === 'jira' && config.jira) return jiraTracker(config.jira, env, fetchImpl);
  if (kind === 'clickup' && config.clickup) return clickupTracker(config.clickup, env, fetchImpl);
  throw new FilingUnavailable(
    'not-configured',
    'No bug tracker configured (add a clickup or jira section to .qa/config.ts)',
  );
}

export interface TrackerStatus {
  kind: TrackerKind;
  name: string;
  /** Bugs are filed here (the tracker in use). */
  active: boolean;
  state: 'not-configured' | 'missing-credentials' | 'connected' | 'error';
  /** Names (never values) of the environment variables that still need to be set. */
  missingEnv: string[];
  target: string | null;
  /** Where bugs go when connected, or the error. */
  detail?: string;
}

/**
 * Status of each tracker for the dashboard: Jira always (so it can be set up), ClickUp when
 * configured. Trackers with credentials are contacted to verify them and their destination.
 */
export async function trackerStatuses(
  config: QaConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: Fetch,
): Promise<TrackerStatus[]> {
  const active = trackerKind(config);
  const kinds: TrackerKind[] = ['jira', ...(config.clickup ? (['clickup'] as const) : [])];
  return Promise.all(
    kinds.map(async (kind): Promise<TrackerStatus> => {
      const info = trackerInfo(config, env, kind);
      const base = {
        kind,
        name: kind === 'jira' ? 'Jira' : 'ClickUp',
        active: kind === active,
        missingEnv: info.missingEnv,
        target: info.target,
      };
      if (info.kind === null) return { ...base, state: 'not-configured' };
      if (!info.credentialsPresent) return { ...base, state: 'missing-credentials' };
      try {
        const detail = await createTracker(config, env, fetchImpl, kind).describeTarget();
        return { ...base, state: 'connected', detail };
      } catch (err) {
        return { ...base, state: 'error', detail: (err as Error).message };
      }
    }),
  );
}

function clickupTracker(
  cfg: NonNullable<QaConfig['clickup']>,
  env: NodeJS.ProcessEnv,
  fetchImpl?: Fetch,
): IssueTracker {
  const token = env[cfg.tokenEnv];
  if (!token) throw new FilingUnavailable('missing-token', `Environment variable ${cfg.tokenEnv} is not set`);
  const client = new ClickUpClient(token, fetchImpl);
  return {
    kind: 'clickup',
    name: 'ClickUp',
    noun: 'task',
    attachEvidence: cfg.attachEvidence,
    async describeTarget() {
      const list = await client.getList(cfg.listId);
      return `list "${list.name}" (${list.id})`;
    },
    async create(bug) {
      const task = await client.createTask(cfg.listId, {
        name: bug.title,
        markdown: bug.markdown,
        tags: [...cfg.tags, ...bug.labels],
        priority: PRIORITY[bug.severity],
        status: cfg.status,
      });
      return { id: task.id, url: task.url };
    },
    async comment(id, text) {
      await client.addComment(id, text);
    },
    async attach(id, file) {
      await client.uploadAttachment(id, file);
    },
    exists: (id) => client.taskExists(id),
  };
}

function jiraTracker(
  cfg: NonNullable<QaConfig['jira']>,
  env: NodeJS.ProcessEnv,
  fetchImpl?: Fetch,
): IssueTracker {
  const token = env[cfg.tokenEnv];
  const email = cfg.email ?? env[cfg.emailEnv];
  if (!token) throw new FilingUnavailable('missing-token', `Environment variable ${cfg.tokenEnv} is not set`);
  if (!email) {
    throw new FilingUnavailable(
      'missing-token',
      `No Jira account email: set jira.email or the ${cfg.emailEnv} environment variable`,
    );
  }
  const client = new JiraClient(cfg.baseUrl, email, token, fetchImpl);
  return {
    kind: 'jira',
    name: 'Jira',
    noun: 'issue',
    attachEvidence: cfg.attachEvidence,
    async describeTarget() {
      const p = await client.getProject(cfg.projectKey);
      return `project "${p.name}" (${p.key}) on ${cfg.baseUrl}`;
    },
    async create(bug) {
      const issue = await client.createIssue(cfg.projectKey, {
        summary: bug.title,
        markdown: bug.markdown,
        labels: [...cfg.labels, ...bug.labels],
        issueType: cfg.issueType,
        priority: cfg.priorities[bug.severity],
      });
      return { id: issue.key, url: issue.url };
    },
    async comment(id, text) {
      await client.addComment(id, text);
    },
    async attach(id, file) {
      await client.uploadAttachment(id, file);
    },
    exists: (id) => client.issueExists(id),
  };
}
