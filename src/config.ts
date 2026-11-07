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
  base_branch?: string;
  runtimes?: { default?: RuntimeName; roles?: Record<string, RuntimeName> };
  models?: Record<string, string>;
  commands: { setup?: string[]; check: string[] };
  opt_ins?: { backlog?: 'markdown'; docs?: 'markdown'; notifications?: 'desktop' | 'none' };
}

export interface Policy {
  max_attempts: number;
  max_tokens_per_item: number;
  denied_commands: string[];
  approval_paths: string[];
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
    denied_commands: union(base.denied_commands, override.denied_commands),
    approval_paths: union(base.approval_paths, override.approval_paths),
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
