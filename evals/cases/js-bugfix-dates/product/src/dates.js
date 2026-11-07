const DAY = 24 * 60 * 60 * 1000;

/** Whole days from `from` to `to`, both "YYYY-MM-DD". */
export function daysBetween(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  return Math.abs(Math.round((b - a) / DAY));
}
