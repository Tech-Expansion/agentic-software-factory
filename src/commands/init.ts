import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { git, isRepo } from '../git.js';
import { factoryHome, factoryRoot } from '../paths.js';
import { version } from '../version.js';

const TEMPLATE = join(factoryRoot, 'templates', 'product');

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = join(prefix, name);
    return statSync(join(dir, name)).isDirectory() ? listFiles(join(dir, name), rel) : [rel];
  });
}

/** Template files named `_gitignore` are installed as `.gitignore`, because npm drops `.gitignore` from packages. */
const target = (rel: string) => rel.replace(/(^|\/)_gitignore$/, '$1.gitignore');

export function registerProduct(name: string, path: string): void {
  const file = join(factoryHome(), 'projects.yaml');
  mkdirSync(factoryHome(), { recursive: true });
  const list = existsSync(file) ? ((parse(readFileSync(file, 'utf8')) as { name: string; path: string }[] | null) ?? []) : [];
  if (!list.some((p) => p.path === path)) list.push({ name, path });
  writeFileSync(file, stringify(list));
}

/** Creates a product skeleton in `dir`. Existing files are never overwritten. */
export function init(dir: string, name?: string): { created: string[]; skipped: string[] } {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const productName = name ?? basename(root);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const rel of listFiles(TEMPLATE)) {
    const dest = join(root, target(rel));
    if (existsSync(dest) && target(rel).endsWith('.gitignore')) {
      // An existing .gitignore gets the factory's lines added, so local run state never gets committed.
      const have = new Set(readFileSync(dest, 'utf8').split('\n').map((l) => l.trim()));
      const add = readFileSync(join(TEMPLATE, rel), 'utf8').split('\n').filter((l) => l.trim() && !have.has(l.trim()));
      if (add.length) writeFileSync(dest, `${readFileSync(dest, 'utf8').replace(/\n?$/, '\n')}${add.join('\n')}\n`);
      (add.length ? created : skipped).push(relative(root, dest));
      continue;
    }
    if (existsSync(dest)) {
      skipped.push(relative(root, dest));
      continue;
    }
    mkdirSync(join(dest, '..'), { recursive: true });
    cpSync(join(TEMPLATE, rel), dest);
    const text = readFileSync(dest, 'utf8');
    if (text.includes('{{')) {
      writeFileSync(dest, text.replaceAll('{{name}}', productName).replaceAll('{{factory_version}}', version));
    }
    created.push(relative(root, dest));
  }
  if (!isRepo(root)) git(root, ['init', '-q', '-b', 'main']);
  registerProduct(productName, root);
  return { created, skipped };
}
