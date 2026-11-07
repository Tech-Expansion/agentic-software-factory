/** Splits one CSV line into fields. Quoted fields may hold commas, and "" stands for one quote. */
export function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') fields.push(field), (field = '');
    else field += ch;
  }
  if (quoted) throw new SyntaxError(`unclosed quote in: ${line}`);
  fields.push(field);
  return fields;
}

/** Reads CSV text with a header line into one object per row. */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? '');
  const rows = [];
  for (let n = 1; n < lines.length; n++) {
    if (lines[n] === '') continue;
    const fields = parseCsvLine(lines[n]);
    if (fields.length !== header.length) {
      throw new Error(`line ${n + 1}: ${fields.length} fields, the header has ${header.length}`);
    }
    rows.push(Object.fromEntries(header.map((h, i) => [h, fields[i]])));
  }
  return rows;
}
