import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factoryRoot } from './paths.js';

export const version = (JSON.parse(readFileSync(join(factoryRoot, 'package.json'), 'utf8')) as { version: string }).version;
