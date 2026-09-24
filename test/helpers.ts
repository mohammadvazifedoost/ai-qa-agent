import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Create a throwaway project directory from a map of relative paths to file contents. */
export function makeProject(files: Record<string, string | object>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-qa-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}
