import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ValidateFunction } from 'ajv';
import { factoryRoot, type ProductPaths } from './paths.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv') as typeof import('ajv').default;
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();

export type RuntimeName = 'claude-code' | 'codex';

export interface ProjectConfig {
  factory_version: string;
  name: string;
  stage: 'explore' | 'validate' | 'grow';
  hypothesis?: string;
  success_metric?: string;
  kill_criteria?: string;
  /** The development line: items that pass merge into it on their own. */
  base_branch?: string;
  /** What is live: only the owner's release brings the base branch into it. */
  production_branch?: string;
  /** The git remote the release pull request goes to; without one, `asf release` merges locally. */
  remote?: string;
  runtimes?: { default?: RuntimeName; roles?: Record<string, RuntimeName> };
  models?: Record<string, string>;
  commands: { setup?: string[]; check: string[] };
  /** The workflow items run unless they name another; feature when unset. */
  workflow?: string;
  /** Named path lists a workflow step's `when.touches` can use, for example `ui` for the UX designer's review. */
  paths?: Record<string, string[]>;
  /** Specialist reviewers the product turns on (security-reviewer, ux-designer); their steps are skipped otherwise. */
  specialists?: string[];
  /** Commands per environment for `asf deploy <env>`, run by the runner with the owner's own environment. */
  deploy?: Record<string, string[]>;
  /**
   * How the dev environment deploys itself after each merge into the base branch: `push` pushes it to `remote` for
   * the hosting or CI to deploy; `commands` runs `deploy.dev` sandboxed, seeing only the secrets in `env` and
   * reaching only the package registries and the hosts in `network`.
   */
  dev_deploy?: { run: 'push' | 'commands'; env?: string[]; network?: string[] };
  opt_ins?: { backlog?: 'markdown'; docs?: 'markdown'; notifications?: 'desktop' | 'none' };
  tracker?: TrackerConfig;
}

export type TrackedState = 'clarifying' | 'ready' | 'in_progress' | 'review' | 'done' | 'blocked';

export interface TrackerConfig {
  kind: 'jira';
  project: string;
  owner: string;
  intake_status?: string;
  /** More JQL the intake must match, for a project shared by several products. */
  intake_filter?: string;
  statuses?: Partial<Record<TrackedState, string>>;
  /** A ticket for the owner's view of the whole product: a daily digest, and the board on "/status". */
  digest?: string;
}

export interface Policy {
  max_attempts: number;
  max_tokens_per_item: number;
  check_rounds_in_session: number;
  denied_commands: string[];
  approval_paths: string[];
  owner_paths: string[];
  /** What runs with credentials when dev deploys itself: a change here waits for the owner while dev_deploy is on. */
  deploy_paths: string[];
  protected_paths: string[];
  sensitive_paths: string[];
  test_paths: string[];
  secret_patterns: string[];
  sandbox: SandboxPolicy;
}

export interface SandboxPolicy {
  network_allow: string[];
  deny_read: string[];
  write_allow: string[];
  secret_env: string[];
  /** Lets sandboxed processes listen and connect on loopback (test runners that talk over a local socket). */
  local_binding: boolean;
}

export class ConfigError extends Error {}

const VENDOR_UNSUPPORTED = new Set(['$schema', '$id', 'title', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems']);

/**
 * A schema as sent to a CLI's structured-output mode, which rejects some JSON Schema keywords. The runner still
 * validates the answer against the full schema.
 */
export function vendorSchema(name: string): object {
  const strip = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !VENDOR_UNSUPPORTED.has(k)).map(([k, x]) => [k, strip(x)])) : v;
  return strip(loadSchema(name)) as object;
}

export function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(factoryRoot, 'schemas', `${name}.schema.json`), 'utf8')) as object;
}

/** Validates `data` against `schemas/<name>.schema.json` and returns readable errors. */
export function validate(name: string, data: unknown): string[] {
  let v = validators.get(name);
  if (!v) {
    v = ajv.compile(loadSchema(name));
    validators.set(name, v);
  }
  if (v(data)) return [];
  return (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}

function readYaml(file: string): unknown {
  try {
    return parse(readFileSync(file, 'utf8')) ?? {};
  } catch (err) {
    throw new ConfigError(`${file}: ${(err as Error).message}`);
  }
}

function loadValidated<T>(file: string, schema: string): T {
  const data = readYaml(file);
  const errors = validate(schema, data);
  if (errors.length) throw new ConfigError(`${file}:\n  ${errors.join('\n  ')}`);
  return data as T;
}

export function loadProject(paths: ProductPaths): ProjectConfig {
  return loadValidated<ProjectConfig>(paths.project, 'project');
}

export function loadDefaultPolicy(): Policy {
  return loadValidated<Policy>(join(factoryRoot, 'policies', 'default.yaml'), 'policy');
}

/** A product policy can only tighten the default: limits take the lower value, lists are added to. */
export function mergePolicy(base: Policy, override: Partial<Omit<Policy, 'sandbox'>> & { sandbox?: Partial<SandboxPolicy> }): Policy {
  const union = (a: string[], b: string[] | undefined) => [...new Set([...a, ...(b ?? [])])];
  return {
    max_attempts: Math.min(base.max_attempts, override.max_attempts ?? Infinity),
    max_tokens_per_item: Math.min(base.max_tokens_per_item, override.max_tokens_per_item ?? Infinity),
    check_rounds_in_session: Math.min(base.check_rounds_in_session ?? 0, override.check_rounds_in_session ?? Infinity),
    denied_commands: union(base.denied_commands, override.denied_commands),
    approval_paths: union(base.approval_paths, override.approval_paths),
    owner_paths: union(base.owner_paths ?? [], override.owner_paths),
    deploy_paths: union(base.deploy_paths ?? [], override.deploy_paths),
    protected_paths: union(base.protected_paths, override.protected_paths),
    sensitive_paths: union(base.sensitive_paths, override.sensitive_paths),
    test_paths: union(base.test_paths, override.test_paths),
    secret_patterns: union(base.secret_patterns, override.secret_patterns),
    sandbox: {
      // The one list a product widens: the hosts it needs. Only the owner can edit .factory/policy.yaml.
      network_allow: union(base.sandbox.network_allow, override.sandbox?.network_allow),
      deny_read: union(base.sandbox.deny_read, override.sandbox?.deny_read),
      write_allow: base.sandbox.write_allow,
      secret_env: union(base.sandbox.secret_env, override.sandbox?.secret_env),
      local_binding: base.sandbox.local_binding || (override.sandbox?.local_binding ?? false),
    },
  };
}

export function loadPolicy(paths: ProductPaths): Policy {
  const base = loadDefaultPolicy();
  if (!existsSync(paths.policy)) return base;
  return mergePolicy(base, loadValidated<Partial<Policy>>(paths.policy, 'policy'));
}

export function runtimeFor(project: ProjectConfig, role: string): RuntimeName {
  return project.runtimes?.roles?.[role] ?? project.runtimes?.default ?? 'claude-code';
}

export function modelFor(project: ProjectConfig, role: string): string | undefined {
  return project.models?.[role];
}

/**
 * Specialists the product's own settings call for and that are not on: the security reviewer once there are
 * sensitive paths (keys, signing, money, auth), the UX designer once there is a `ui` path list. The team suggests;
 * the owner turns one on by adding it to `specialists:`.
 */
export function suggestedSpecialists(project: ProjectConfig, policy: Policy): { role: string; why: string }[] {
  const on = new Set(project.specialists ?? []);
  const out: { role: string; why: string }[] = [];
  if (policy.sensitive_paths.length && !on.has('security-reviewer')) out.push({ role: 'security-reviewer', why: `the product has sensitive paths (${policy.sensitive_paths.join(', ')})` });
  if (project.paths?.ui?.length && !on.has('ux-designer')) out.push({ role: 'ux-designer', why: 'the product has a ui path list' });
  return out;
}
