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
