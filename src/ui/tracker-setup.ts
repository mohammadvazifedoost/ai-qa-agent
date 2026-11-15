/**
 * The dashboard's Bug tracker page: what is set up now, and connecting ClickUp or Jira. A
 * connection is tested with the tracker's own API before anything is saved. The list, site and
 * project go into `.qa/config.ts`; the token goes into `.qa/.env.local` on this computer only.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { setConfigProperty, toSource } from '../config/edit.js';
import { loadConfig } from '../config/load.js';
import { LOCAL_ENV_FILE, saveLocalEnv } from '../config/local-env.js';
import { QaConfigSchema, type QaConfig } from '../config/schema.js';
import type { Fetch } from '../integrations/clickup.js';
import { createTracker, trackerKind, type TrackerKind } from '../integrations/tracker.js';
import type { QaContext } from '../pipeline/context.js';

/** What the form shows. Never a token, only whether one is set. */
export interface TrackerSettings {
  active: TrackerKind | null;
  secretsFile: string;
  clickup: { listId: string; status: string; tokenEnv: string; tokenSet: boolean } | null;
  jira: {
    baseUrl: string;
    projectKey: string;
    email: string;
    tokenEnv: string;
    tokenSet: boolean;
  } | null;
}

export function trackerSettings(config: QaConfig, env: NodeJS.ProcessEnv = process.env): TrackerSettings {
  const c = config.clickup;
  const j = config.jira;
  return {
    active: trackerKind(config),
    secretsFile: '.qa/' + LOCAL_ENV_FILE,
    clickup: c
      ? { listId: c.listId, status: c.status ?? '', tokenEnv: c.tokenEnv, tokenSet: !!env[c.tokenEnv] }
      : null,
    jira: j
      ? {
          baseUrl: j.baseUrl,
          projectKey: j.projectKey,
          email: j.email ?? env[j.emailEnv] ?? '',
          tokenEnv: j.tokenEnv,
          tokenSet: !!env[j.tokenEnv],
        }
      : null,
  };
}

const optional = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => v || undefined);

export const TrackerInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('clickup'),
    listId: z
      .string()
      .trim()
      .regex(
        /^\d+$/,
        'The list ID is a number: open the list in ClickUp and copy the number after /li/ in its address.',
      ),
    status: optional,
    token: optional,
  }),
  z.object({
    kind: z.literal('jira'),
    baseUrl: z
      .string()
      .trim()
      .url('Enter the address of your Jira site, e.g. https://yourco.atlassian.net.')
      .refine((u) => /^https?:\/\//.test(u), 'The site address starts with https://.')
      .transform((u) => u.replace(/\/+$/, '')),
    projectKey: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9_]+$/, 'The project key is the short code in front of issue numbers, e.g. SHOP.'),
    email: z.string().trim().email('Enter the email address of your Atlassian account.'),
    token: optional,
  }),
]);
export type TrackerInput = z.infer<typeof TrackerInputSchema>;

export class TrackerSetupError extends Error {}

/** The config section the input describes, keeping the settings it does not ask about. */
function sectionFor(
  config: QaConfig,
  input: TrackerInput,
): NonNullable<QaConfig['clickup'] | QaConfig['jira']> {
  if (input.kind === 'clickup') {
    const old = config.clickup;
    return QaConfigSchema.shape.clickup.unwrap().parse({
      ...old,
      listId: input.listId,
      status: input.status,
    });
  }
  const old = config.jira;
  return QaConfigSchema.shape.jira.unwrap().parse({
    ...old,
    baseUrl: input.baseUrl,
    projectKey: input.projectKey,
    // The account email is kept with the token on this computer, not in the committed config.
    email: undefined,
  });
}

function prepare(config: QaConfig, body: unknown, env: NodeJS.ProcessEnv) {
  const parsed = TrackerInputSchema.safeParse(body);
  if (!parsed.success) throw new TrackerSetupError(parsed.error.issues[0]?.message ?? 'Invalid settings');
  const input = parsed.data;
  const section = sectionFor(config, input);
  const token = input.token ?? env[section.tokenEnv];
  if (!token) throw new TrackerSetupError('Enter the API token.');
  if (/\s/.test(token)) throw new TrackerSetupError('The API token cannot contain spaces or line breaks.');
  const candidate = { ...config, [input.kind]: section, tracker: input.kind } as QaConfig;
  // What goes into .qa/.env.local: the token, and for Jira the account email.
  const secrets: Record<string, string> = { [section.tokenEnv]: token };
  if (input.kind === 'jira' && 'emailEnv' in section) secrets[section.emailEnv] = input.email;
  return { input, section, token, secrets, candidate, testEnv: { ...env, ...secrets } };
}

/** Try the settings against the tracker without saving anything. Returns where bugs would go. */
export async function testTracker(
  config: QaConfig,
  body: unknown,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: Fetch } = {},
): Promise<string> {
  const { input, candidate, testEnv } = prepare(config, body, opts.env ?? process.env);
  try {
    return await createTracker(candidate, testEnv, opts.fetchImpl, input.kind).describeTarget();
  } catch (err) {
    throw new TrackerSetupError(friendly(input.kind, (err as Error).message));
  }
}

/**
 * Test, then save: the section in config.ts (and `tracker:` when both trackers are set up), the
 * token in .qa/.env.local. `ctx.config` is reloaded from the file, so the change applies at once.
 */
export async function saveTracker(
  ctx: QaContext,
  body: unknown,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: Fetch } = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const target = await testTracker(ctx.config, body, opts);
  const { input, section, secrets } = prepare(ctx.config, body, env);
  const file = ctx.paths.config;
  const before = fs.readFileSync(file, 'utf8');
  const defaults = QaConfigSchema.shape[input.kind]
    .unwrap()
    .parse(
      input.kind === 'clickup' ? { listId: '0' } : { baseUrl: 'https://x.invalid', projectKey: 'XX' },
    ) as Record<string, unknown>;
  // Write only what differs from the defaults, so the section stays short and readable.
  const written = Object.fromEntries(
    Object.entries(section).filter(
      ([k, v]) =>
        ['listId', 'baseUrl', 'projectKey', 'tokenEnv'].includes(k) ||
        JSON.stringify(v) !== JSON.stringify(defaults[k]),
    ),
  );
  let after = setConfigProperty(before, input.kind, toSource(written));
  const other = input.kind === 'clickup' ? 'jira' : 'clickup';
  if (ctx.config[other] || ctx.config.tracker)
    after = setConfigProperty(after, 'tracker', JSON.stringify(input.kind));
  fs.writeFileSync(file, after);
  try {
    ctx.config = await loadConfig(ctx.root);
  } catch (err) {
    fs.writeFileSync(file, before);
    throw new TrackerSetupError('Could not update .qa/config.ts: ' + (err as Error).message);
  }
  // Only what is new: a token taken from the shell stays there.
  const changed = Object.fromEntries(Object.entries(secrets).filter(([k, v]) => env[k] !== v));
  if (Object.keys(changed).length) saveLocalEnv(ctx.paths.qaDir, changed, env);
  return target;
}

/** Turn an API error into what to fix. */
function friendly(kind: TrackerKind, message: string): string {
  const name = kind === 'clickup' ? 'ClickUp' : 'Jira';
  if (/\b401\b|unauthori[sz]ed|OAUTH_0\d\d|token/i.test(message))
    return `${name} did not accept the token. Check that it was copied whole and is still valid. (${message})`;
  if (/\b404\b|not found|does not exist/i.test(message))
    return kind === 'clickup'
      ? `The token works, but ClickUp has no list with this ID that it can see. (${message})`
      : `The token works, but there is no project with this key that your account can see. (${message})`;
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|EAI_AGAIN/i.test(message))
    return `Could not reach ${name}. Check the address and your connection. (${message})`;
  return `${name} answered with an error: ${message}`;
}
