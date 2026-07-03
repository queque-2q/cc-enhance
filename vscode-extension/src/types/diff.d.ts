declare module 'diff' {
  export interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
    linedelimiters: string[];
  }

  export interface ParsedDiff {
    oldFileName?: string;
    newFileName?: string;
    oldHeader?: string;
    newHeader?: string;
    hunks: Hunk[];
    index?: string;
  }

  export function parsePatch(patch: string, options?: { strict?: boolean }): ParsedDiff[];
  export function applyPatch(
    source: string,
    patch: string | ParsedDiff | ParsedDiff[],
    options?: { compareLine?: (lineNumber: number, line: string, operation: string, patchContent: string) => boolean }
  ): string | false;
}
