const DAY = 24 * 60 * 60 * 1000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(value) {
  const m = typeof value === 'string' ? ISO.exec(value) : null;
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const back = new Date(Date.UTC(y, mo - 1, d));
    if (back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d) return back.getTime();
  }
  throw new RangeError(`not a calendar date in YYYY-MM-DD form: ${String(value)}`);
}

/** Calendar days from `from` to `to`, both "YYYY-MM-DD"; negative when `to` is earlier. */
export function daysBetween(from, to) {
  return (parse(to) - parse(from)) / DAY;
}
