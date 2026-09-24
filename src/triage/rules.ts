import type { TestOutcome } from '../runner/results.js';
import type { Classification } from './schema.js';

export interface RuleVerdict {
  classification: Classification;
  confidence: number;
  summary: string;
}

const ENVIRONMENT = [
  /net::ERR_CONNECTION_REFUSED/,
  /net::ERR_NAME_NOT_RESOLVED/,
  /net::ERR_CONNECTION_RESET/,
  /ECONNREFUSED/,
  /getaddrinfo ENOTFOUND/,
];

const INFRASTRUCTURE = [
  /Executable doesn't exist/,
  /browserType\.launch/,
  /ENOSPC/,
  /out of memory/i,
  /Browser (closed|has been closed) unexpectedly/i,
];

const TEST_CODE = [/SyntaxError:/, /ReferenceError:/, /Cannot find module/, /is not a function/];

/**
 * Deterministic classification for failures whose cause is unambiguous from the error alone.
 * Returns null when the failure needs AI analysis of the evidence.
 */
export function classifyByRules(outcome: TestOutcome): RuleVerdict | null {
  if (outcome.status === 'flaky') {
    return {
      classification: 'UNKNOWN',
      confidence: 0.5,
      summary: `Flaky: failed, then passed on retry (${outcome.attempts} attempts). Not filed; investigate if it recurs.`,
    };
  }
  const message = `${outcome.error?.message ?? ''}\n${outcome.error?.stack ?? ''}`;
  if (ENVIRONMENT.some((re) => re.test(message))) {
    return {
      classification: 'ENVIRONMENT_FAILURE',
      confidence: 0.95,
      summary: 'The application could not be reached (connection refused / DNS failure).',
    };
  }
  if (INFRASTRUCTURE.some((re) => re.test(message))) {
    return {
      classification: 'INFRASTRUCTURE_FAILURE',
      confidence: 0.95,
      summary: 'The browser or test infrastructure failed (browser missing, crashed or out of resources).',
    };
  }
  const inTestCode = outcome.error?.stack?.split('\n').slice(0, 3).join('\n') ?? '';
  if (TEST_CODE.some((re) => re.test(message)) && /\.spec\.ts/.test(inTestCode)) {
    return {
      classification: 'TEST_BUG',
      confidence: 0.9,
      summary: 'The test code itself threw a programming error.',
    };
  }
  return null;
}
