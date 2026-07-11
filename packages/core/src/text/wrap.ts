/**
 * Word wrap for drawtext overlays/captions. FFmpeg's drawtext does no automatic
 * wrapping — a long single-line title just runs off the canvas — so the engine
 * wraps text before writing each textfile.
 *
 * The line budget is a HEURISTIC: usable width ≈ 90% of the canvas, average
 * glyph advance ≈ 0.55 × fontSize for typical proportional faces. That errs
 * slightly narrow (wraps a touch early) which reads better than clipping.
 */

/** Max characters that fit one line at this canvas width / font size. */
export function maxCharsPerLine(canvasWidth: number, fontSize: number): number {
  return Math.max(4, Math.floor((canvasWidth * 0.9) / (Math.max(1, fontSize) * 0.55)));
}

/**
 * Wrap `text` to `maxChars` per line, breaking at spaces (a single word longer
 * than the budget stays unbroken — never split mid-word). Text that ALREADY
 * contains newlines is returned untouched: explicit line breaks are the
 * author's intent.
 */
export function wrapText(text: string, maxChars: number): string {
  if (text.includes("\n")) return text;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line.length) {
      line = word;
    } else if (line.length + 1 + word.length <= maxChars) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length) lines.push(line);
  return lines.join("\n");
}
