#!/usr/bin/env node
import { parseArgs } from 'node:util';

const USAGE = `Usage: greet [--name <name>] [--shout]

  --name <name>  who to greet (default: world)
  --shout        print the greeting in upper case
  -h, --help     show this help
`;

function fail(message) {
  process.stderr.write(`greet: ${message}\n`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    options: { name: { type: 'string' }, shout: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  }));
} catch (err) {
  const unknown = /Unknown option '([^']+)'/.exec(err.message);
  fail(unknown ? `unknown option ${unknown[1]}` : err.message.split('\n')[0]);
}
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const greeting = `Hello, ${values.name ?? 'world'}!`;
console.log(values.shout ? greeting.toUpperCase() : greeting);
