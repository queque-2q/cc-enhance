/**
 * A single diff change as reported by Monaco's diff editor
 * (`diffEditor.getLineChanges()`). Ranges are 1-based and inclusive.
 * An empty range is `start = end + 1` (pure insertion/deletion on that side).
 */
export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/**
 * Return the text of lines [start..end] (1-based, inclusive) of `content`,
 * joined with '\n' and with no trailing newline. Returns '' when the range
 * is empty (end < start) or out of bounds.
 */
export function extractLines(content: string, start: number, end: number): string {
  if (end < start) return '';
  const lines = content === '' ? [] : content.split('\n');
  const s = Math.max(0, start - 1);
  const e = Math.min(end, lines.length);
  if (s >= e) return '';
  return lines.slice(s, e).join('\n');
}

/**
 * Replace lines [start..end] (1-based, inclusive) of `content` with
 * `replacement`. An empty range (end < start) means a pure insertion before
 * line `start`. `replacement` may be '' (deletion). Returns the new content.
 */
export function replaceLineRange(
  content: string,
  start: number,
  end: number,
  replacement: string
): string {
  const lines = content === '' ? [] : content.split('\n');
  if (end < start) {
    // Pure insertion: insert `replacement` before 1-based line `start`.
    const insertAt = Math.max(0, Math.min(start - 1, lines.length));
    const rep = replacement === '' ? [] : replacement.split('\n');
    lines.splice(insertAt, 0, ...rep);
    return lines.join('\n');
  }
  // Replacement over [start..end].
  const s = Math.max(0, start - 1);
  const e = Math.max(0, Math.min(end, lines.length));
  const rep = replacement === '' ? [] : replacement.split('\n');
  lines.splice(s, e - s, ...rep);
  return lines.join('\n');
}
