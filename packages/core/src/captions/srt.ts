/**
 * SRT / WebVTT caption interop. Pure text transforms — cue times in SECONDS —
 * used by export_captions (timeline → sidecar) and import_captions (sidecar →
 * clip caption track). No dependencies; both formats are plain text.
 */

export interface SidecarCue {
  /** Absolute time in seconds. */
  start: number;
  end: number;
  text: string;
}

/** hh:mm:ss,mmm (SRT) or hh:mm:ss.mmm (VTT) → seconds. */
function parseTimecode(tc: string): number {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(tc.trim());
  if (!m) throw new Error(`Unparseable caption timecode "${tc.trim()}" — expected hh:mm:ss,mmm (SRT) or hh:mm:ss.mmm (VTT).`);
  const [, h, min, s, ms] = m;
  return (h ? Number(h) * 3600 : 0) + Number(min) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

function formatTimecode(sec: number, msSep: "," | "."): string {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSep}${pad(ms, 3)}`;
}

/** Parse SubRip (.srt) content into cues. Tolerates \r\n and missing indices. */
export function parseSrt(content: string): SidecarCue[] {
  const cues: SidecarCue[] = [];
  const blocks = content.replace(/^﻿/, "").split(/\r?\n\r?\n+/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (!lines.length) continue;
    // Optional numeric index line, then the timing line.
    let i = 0;
    if (/^\d+$/.test(lines[0].trim()) && lines.length > 1) i = 1;
    const timing = /(.+?)\s+--?>\s+(.+)/.exec(lines[i] ?? "");
    if (!timing) continue;
    const text = lines.slice(i + 1).join("\n").trim();
    if (!text) continue;
    const start = parseTimecode(timing[1]);
    const end = parseTimecode(timing[2]);
    if (end > start) cues.push({ start, end, text });
  }
  return cues;
}

/** Parse WebVTT (.vtt) content into cues (ignores NOTE/STYLE blocks + settings). */
export function parseVtt(content: string): SidecarCue[] {
  const body = content.replace(/^﻿?WEBVTT[^\n]*\r?\n/, "");
  const cues: SidecarCue[] = [];
  for (const block of body.split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (!lines.length) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    let i = lines[0].includes("-->") ? 0 : 1; // optional cue identifier line
    const timing = /(.+?)\s+--?>\s+([^\s]+)/.exec(lines[i] ?? "");
    if (!timing) continue;
    const text = lines
      .slice(i + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "") // strip inline styling tags
      .trim();
    if (!text) continue;
    const start = parseTimecode(timing[1]);
    const end = parseTimecode(timing[2]);
    if (end > start) cues.push({ start, end, text });
  }
  return cues;
}

/** Serialize cues (sorted) as SubRip. */
export function formatSrt(cues: SidecarCue[]): string {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  return sorted
    .map((c, i) => `${i + 1}\n${formatTimecode(c.start, ",")} --> ${formatTimecode(c.end, ",")}\n${c.text}`)
    .join("\n\n") + "\n";
}

/** Serialize cues (sorted) as WebVTT. */
export function formatVtt(cues: SidecarCue[]): string {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  return (
    "WEBVTT\n\n" +
    sorted.map((c) => `${formatTimecode(c.start, ".")} --> ${formatTimecode(c.end, ".")}\n${c.text}`).join("\n\n") +
    "\n"
  );
}
