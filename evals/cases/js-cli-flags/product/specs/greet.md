# greet

A small command line greeter, run as `node bin/greet.js [options]`. Tests live in `test/` and run with `node --test`.

## Acceptance criteria

- AC-001: With no options it prints `Hello, world!` and a newline to stdout and exits with 0.
- AC-002: `--name <name>` greets that name: `--name Lan` prints `Hello, Lan!`. `--name=Lan` works the same way.
  `--name` without a value is a usage error.
- AC-003: `--shout` prints the whole greeting in upper case: `--name Lan --shout` prints `HELLO, LAN!`. Options can
  come in any order.
- AC-004: `--help` or `-h` prints a usage text that mentions every option to stdout and exits with 0.
- AC-005: A usage error (an unknown option, a missing value, an unexpected argument) prints one line starting with
  `greet: ` to stderr, prints nothing to stdout, and exits with 2. For an unknown option the line names it:
  `greet: unknown option --loud`.
- AC-006: No dependencies are added; only Node's standard library is used.
