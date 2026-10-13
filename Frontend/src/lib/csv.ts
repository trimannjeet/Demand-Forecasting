export interface ParsedCsv { headers: string[]; rows: Record<string, string>[] }
// Small RFC-4180-style parser supporting quoted cells, escaped quotes, commas and newlines.
export function parseCsv(input: string): ParsedCsv {
  const matrix: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  const text = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false; else cell += char; }
    else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i + 1] === '\n') i++; row.push(cell); matrix.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell.length || row.length) { row.push(cell); matrix.push(row); }
  while (matrix.length && matrix[matrix.length - 1].every(value => value.trim() === '')) matrix.pop();
  if (!matrix.length) throw new Error('The CSV file is empty.');
  const headers = matrix[0].map((value, i) => value.trim() || `Column ${i + 1}`);
  if (new Set(headers).size !== headers.length) throw new Error('Column headers must be unique. Rename duplicate columns in your CSV and try again.');
  const rows = matrix.slice(1).map((values, rowIndex) => {
    if (values.length > headers.length && values.slice(headers.length).some(v => v.trim())) throw new Error(`Row ${rowIndex + 2} contains more cells than the header row.`);
    return Object.fromEntries(headers.map((header, i) => [header, values[i] ?? '']));
  });
  return { headers, rows };
}
function escapeCell(value: unknown): string { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
export function downloadCsv(filename: string, headers: string[], rows: Array<Record<string, unknown>>): void {
  const content = [headers.map(escapeCell).join(','), ...rows.map(row => headers.map(header => escapeCell(row[header])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8;' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}
