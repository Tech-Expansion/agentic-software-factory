import { git } from './git.js';
import { matchesAny } from './glob.js';

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

/** The added lines of a unified diff, with the file and the line number they land on. */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = '';
  let line = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (l.startsWith('--- ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (l.startsWith('+')) out.push({ file, line: line++, text: l.slice(1) });
    else if (!l.startsWith('-') && !l.startsWith('\\')) line++;
  }
  return out;
}

const BUILTIN_SECRETS: [string, RegExp][] = [
  ['Anthropic key or token', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['Atlassian API token', /\bATATT[A-Za-z0-9_\-=]{40,}/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
];

/**
 * What looks like a secret in the added lines. Reports where and what kind, never the value, because the report
 * goes back into a prompt and into the run log.
 */
export function findSecrets(diff: string, extra: string[] = []): string[] {
  const patterns: [string, RegExp][] = [...BUILTIN_SECRETS, ...extra.map((p): [string, RegExp] => ['policy secret pattern', new RegExp(p)])];
  const hits: string[] = [];
  for (const a of addedLines(diff)) {
    const kind = patterns.find(([, re]) => re.test(a.text))?.[0];
    if (kind) hits.push(`${a.file}:${a.line}: ${kind}`);
  }
  return hits;
}

/** Ways to make a test suite pass without making the code right: skip, focus or mark as to-do. */
const SKIP =
  /\b(?:it|test|describe|context|suite)\.(?:skip|todo|only)\s*\(|\bx(?:it|describe|test)\s*\(|\bf(?:it|describe)\s*\(|\[(?:Fact|Theory)\s*\([^)\]]*Skip\s*=|@(?:Disabled|Ignore)\b|pytest\.mark\.(?:skip|xfail)|\bt\.Skip(?:Now|f)?\(|\{\s*skip\s*:\s*true/;

/**
 * Test files deleted, or a skip added to one, in the staged change against `base`. Removing a test is never how an
 * item gets done; if a test is wrong, that is a question for the owner.
 */
export function testTampering(worktree: string, base: string, testGlobs: string[]): string[] {
  const out: string[] = [];
  const status = git(worktree, ['diff', '--cached', '--name-status', '-M', base]).split('\n').filter(Boolean);
  const testFiles: string[] = [];
  for (const row of status) {
    const [code = '', a = '', b] = row.split('\t');
    if (code === 'D' && matchesAny(a, testGlobs)) out.push(`deleted test file ${a}`);
    else if (code.startsWith('R') && matchesAny(a, testGlobs) && b && !matchesAny(b, testGlobs)) out.push(`moved test file ${a} out of the tests, to ${b}`);
    const now = b ?? a;
    if (code !== 'D' && matchesAny(now, testGlobs)) testFiles.push(now);
  }
  if (testFiles.length) {
    const diff = git(worktree, ['diff', '--cached', '-U0', base, '--', ...testFiles]);
    for (const a of addedLines(diff)) if (SKIP.test(a.text)) out.push(`${a.file}:${a.line} skips or focuses tests: ${a.text.trim().slice(0, 120)}`);
  }
  return out;
}
