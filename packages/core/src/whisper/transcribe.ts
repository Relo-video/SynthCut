import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { ensureWhisper, DEFAULT_MODEL, type WhisperModel } from "./setup.js";

/** A single transcribed caption cue. Times are seconds relative to the audio. */
export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
}

/** A single spoken word with its own timing (seconds relative to the audio). */
export interface TranscriptWordTiming {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeOptions {
  /** ggml model to use (downloaded on first use). Default base.en. */
  model?: WhisperModel;
  /** Spoken language, or "auto" to detect. Default "en". */
  language?: string;
  /**
   * Maximum characters per cue. Short cues read better as on-screen captions.
   * Default 32 (with split-on-word so words aren't broken mid-token).
   */
  maxLen?: number;
  /** Number of CPU threads. Default: leave to whisper's own default. */
  threads?: number;
}

/** The shape whisper-cli writes with `-oj`/`-ojf` (`--output-json[-full]`). */
interface WhisperJson {
  transcription?: Array<{
    offsets?: { from?: number; to?: number };
    text?: string;
    /** Present only with -ojf (output-json-full): per-token timing. */
    tokens?: Array<{
      text?: string;
      offsets?: { from?: number; to?: number };
      p?: number;
    }>;
  }>;
}

/**
 * Transcribe an audio file with whisper.cpp and return timed caption cues.
 * The audio should already be a format whisper accepts (wav/mp3/flac/ogg);
 * callers that need an exact range/sample-rate extract a 16 kHz mono WAV first.
 */
export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<TranscriptCue[]> {
  return (await transcribeFull(audioPath, opts)).cues;
}

/**
 * Transcribe with BOTH segment cues and word-level timestamps. Runs whisper-cli
 * with `-ojf` (output-json-full) and merges per-token offsets into words: a
 * token starting with a space begins a new word; punctuation-only tokens attach
 * to the current word; whisper's special `[_...]` tokens are dropped. Word
 * times are clamped monotonic (whisper token offsets can jitter backwards).
 */
export async function transcribeFull(
  audioPath: string,
  opts: TranscribeOptions = {},
): Promise<{ cues: TranscriptCue[]; words: TranscriptWordTiming[] }> {
  const { bin, model } = await ensureWhisper(opts.model ?? DEFAULT_MODEL);

  const work = await mkdtemp(join(tmpdir(), "aive-whisper-"));
  const outPrefix = join(work, "out");
  try {
    const args = [
      "-m",
      model,
      "-f",
      audioPath,
      "-ojf", // write out.json with per-token detail (superset of -oj)
      "-of",
      outPrefix,
      "-ml",
      String(opts.maxLen ?? 32),
      "-sow", // split on word, not mid-token
      "-np", // no progress prints to stdout
    ];
    if (opts.language) args.push("-l", opts.language);
    else args.push("-l", "en");
    if (opts.threads) args.push("-t", String(opts.threads));

    await execa(bin, args, { reject: true });

    const raw = await readFile(`${outPrefix}.json`, "utf8");
    const data = JSON.parse(raw) as WhisperJson;
    const cues: TranscriptCue[] = [];
    const words: TranscriptWordTiming[] = [];

    for (const seg of data.transcription ?? []) {
      const text = (seg.text ?? "").trim();
      if (text) {
        const start = (seg.offsets?.from ?? 0) / 1000;
        const end = (seg.offsets?.to ?? 0) / 1000;
        if (end > start) cues.push({ start, end, text });
      }

      // Merge tokens → words. Tokens carry leading spaces on word starts.
      let current: TranscriptWordTiming | null = null;
      for (const tok of seg.tokens ?? []) {
        const t = tok.text ?? "";
        if (!t || /^\[_.*\]$/.test(t.trim())) continue; // [_BEG_], [_TT_...], etc.
        const from = (tok.offsets?.from ?? 0) / 1000;
        const to = (tok.offsets?.to ?? 0) / 1000;
        const startsWord = t.startsWith(" ") || current === null;
        if (startsWord) {
          if (current && current.text.trim()) words.push(current);
          current = { start: from, end: Math.max(from, to), text: t.trim() };
        } else {
          current!.text += t;
          current!.end = Math.max(current!.end, to);
        }
      }
      if (current && current.text.trim()) words.push(current);
    }

    // Enforce monotonic, non-degenerate word times.
    let prevEnd = 0;
    for (const w of words) {
      if (w.start < prevEnd) w.start = prevEnd;
      if (w.end < w.start) w.end = w.start;
      prevEnd = w.end;
    }
    // Drop empty artifacts (e.g. punctuation-only "words" like a stray period).
    const cleaned = words.filter((w) => /[\p{L}\p{N}]/u.test(w.text));

    return { cues, words: cleaned };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
