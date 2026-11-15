import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxPolicy } from './config.js';

export class SandboxError extends Error {}

/**
 * The operator's way to turn the sandbox on for every product on this machine, whatever its policy says: an
 * always-on host, or CI. A product turns it on for itself with `sandbox.enabled` in `.factory/policy.yaml`.
 */
export const sandboxForced = () => process.env.ASF_SANDBOX === '1';

/**
 * Why agents cannot be sandboxed on this machine, if they cannot. Claude Code's sandbox runs on macOS, Linux and
 * WSL2; on native Windows it runs commands unsandboxed.
 */
export function sandboxUnavailable(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') {
    return 'the sandbox is on, and on Windows it only runs inside WSL2: run asf there, or turn it off (`sandbox.enabled` in .factory/policy.yaml, ASF_SANDBOX)';
  }
  return undefined;
}

/** A sandbox that was asked for is never quietly left out: where it cannot run, nothing starts. */
export function requireSandbox(sb: SandboxPolicy | undefined): void {
  const why = sb?.enabled ? sandboxUnavailable() : undefined;
  if (why) throw new SandboxError(why);
}

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|SESSION_?KEY/i;

/** The environment for agent commands and checks: no secrets, whatever the sandbox does, but the ones in `allow`. */
export function scrubEnv(env: NodeJS.ProcessEnv, secretNames: string[], allow: string[] = []): NodeJS.ProcessEnv {
  const deny = new Set(secretNames);
  const keep = new Set(allow);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (keep.has(k) || (!deny.has(k) && !SECRET_NAME.test(k))) out[k] = v;
  return out;
}

/**
 * Variables that let a toolchain work inside the sandbox, set for checks and for agent commands alike. None is
 * needed for the stacks the eval cases cover; a stack that fails only in the sandbox gets its fix here, with the
 * reason.
 */
export function toolchainEnv(_sb: SandboxPolicy): Record<string, string> {
  // Node reads the OS trust store when NODE_USE_SYSTEM_CA=1 is inherited; on macOS that goes through the keychain
  // and trustd, which the sandbox blocks, so every HTTPS request (npm install, fetch) fails its certificate check.
  // Node's bundled CA list needs neither.
  return { NODE_USE_SYSTEM_CA: '0' };
}

/**
 * /tmp, plus the path it links to. The sandbox matches resolved paths, so on macOS, where /tmp links to
 * /private/tmp, granting '/tmp' alone grants nothing. Tools that hardcode /tmp (pnpm 12 keeps its store lock in
 * /tmp/pnpm-store-operation-locks-<uid>) then fail with "Operation not permitted".
 */
export function tmpRoots(): string[] {
  let real = '/tmp';
  try {
    real = realpathSync('/tmp');
  } catch {
    // No /tmp: nothing to resolve.
  }
  return [...new Set(['/tmp', real])];
}

/** Settings for Anthropic's sandbox runtime (`srt`), which wraps the runner's own checks. */
export function srtSettings(sb: SandboxPolicy): object {
  return {
    network: { allowedDomains: sb.network_allow, deniedDomains: [], allowLocalBinding: sb.local_binding },
    filesystem: { denyRead: sb.deny_read, allowWrite: ['.', tmpdir(), ...tmpRoots(), ...sb.write_allow], denyWrite: [] },
    credentials: { envVars: sb.secret_env.map((name) => ({ name, mode: 'deny' })) },
  };
}

/** The `sandbox` block of Claude Code settings: its Bash tool runs sandboxed, and refuses to run otherwise. */
export function claudeSandbox(sb: SandboxPolicy): object {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    network: { allowedDomains: sb.network_allow, allowLocalBinding: sb.local_binding },
    filesystem: { denyRead: sb.deny_read, allowWrite: [tmpdir(), ...tmpRoots(), ...sb.write_allow] },
    credentials: { envVars: sb.secret_env.map((name) => ({ name, mode: 'deny' })) },
  };
}

/**
 * On Linux the sandbox can only make a path writable if it exists, so the package caches are created first;
 * otherwise a first install finds its cache read-only.
 */
export function prepareWritable(sb: SandboxPolicy): void {
  // The sandbox points TMPDIR at /tmp/claude without creating it; a tool that writes temp files then fails.
  mkdirSync('/tmp/claude', { recursive: true });
  for (const p of sb.write_allow) if (p.startsWith('~/')) mkdirSync(join(homedir(), p.slice(2)), { recursive: true });
}

const settingsFiles = new Map<string, string>();
let srtChecked: boolean | undefined;
export function hasSrt(): boolean {
  srtChecked ??= spawnSync('srt', ['--version'], { encoding: 'utf8' }).status === 0;
  return srtChecked;
}

/** A command line that runs `command` in the sandbox, or as it is when the sandbox is off. */
export function sandboxed(command: string, sb: SandboxPolicy | undefined): { cmd: string; args: string[]; shell: boolean } {
  if (!sb?.enabled) return { cmd: command, args: [], shell: true };
  requireSandbox(sb);
  if (!hasSrt()) {
    throw new SandboxError(
      'the sandbox is on, but its runtime is not installed: `npm install -g @anthropic-ai/sandbox-runtime` (on Linux also bubblewrap and socat), or turn the sandbox off (`sandbox.enabled` in .factory/policy.yaml, ASF_SANDBOX)',
    );
  }
  prepareWritable(sb);
  const json = JSON.stringify(srtSettings(sb));
  let file = settingsFiles.get(json);
  if (!file) {
    file = join(mkdtempSync(join(tmpdir(), 'asf-srt-')), 'settings.json');
    writeFileSync(file, json);
    settingsFiles.set(json, file);
  }
  return { cmd: 'srt', args: ['--settings', file, '-c', command], shell: false };
}
