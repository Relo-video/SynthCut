/**
 * SOTA Phase 3 deliverable: word-level transcripts → text-based editing.
 *  - index_transcript builds word timestamps; get_transcript numbers them.
 *  - Word times are monotonic.
 *  - delete_transcript_ranges removes a middle word range and shortens the
 *    timeline by exactly the reported frames.
 *  - tighten_talk shrinks the sample's long pauses; captions on the surviving
 *    clips stay within their clips (sliceCaptions).
 *  - edit_by_transcript assembles clips from kept text.
 *  - Transcript words survive a save → load round-trip (the asset-cache merge).
 *
 * Run: npx tsx packages/core/scripts/smoke-textedit.ts
 * (Self-contained: uses the checked-in public-domain fixtures/jfk.wav. First
 *  run downloads the whisper model once, like smoke-captions.)
 */
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "jfk.wav");

interface NumberedWord { i: number; start: number; end: number; text: string }

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-textedit-"));
  const engine = new EditorEngine(dataDir);

  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  const summary = () => call<{ totalFrames: number; fps: number; tracks: { trackIndex: number; kind: string; clips: { clipId: string; durationFrames: number }[] }[] }>("timeline_summary", {});
  const clearTimeline = async () => {
    for (const t of (await summary()).tracks) {
      for (const c of t.clips) await call("remove_clip", { clipId: c.clipId });
    }
  };

  console.log("1. import fixture + index transcript with words...");
  const { asset } = await call<{ asset: { id: string } }>("import_video", { path: FIXTURE });
  const indexed = await call<{ segmentCount: number; wordCount: number }>("index_transcript", { assetId: asset.id });
  check(indexed.segmentCount > 0, `segments parsed (${indexed.segmentCount})`);
  check(indexed.wordCount >= 15, `word timestamps parsed (${indexed.wordCount} words)`);

  console.log("2. get_transcript numbers words with monotonic times...");
  const t = (await call<{ transcript: { words: NumberedWord[] } }>("get_transcript", { assetId: asset.id })).transcript;
  const words = t.words;
  check(words.length === indexed.wordCount, "numbered words match wordCount");
  check(words.every((w, i) => w.i === i), "indices are 0..n-1");
  let monotonic = true;
  for (let i = 1; i < words.length; i++) {
    if (words[i].start < words[i - 1].start - 1e-6 || words[i].end < words[i].start - 1e-6) monotonic = false;
  }
  check(monotonic, "word times are monotonic");
  const text = words.map((w) => w.text).join(" ");
  check(/country/i.test(text), `transcript contains the speech ("…${text.slice(0, 60)}…")`);

  console.log("3. delete a middle word range → timeline shortens by the reported frames...");
  await call("append_clip", { assetId: asset.id });
  const before = (await summary()).totalFrames;
  const fps = (await summary()).fps;
  const from = 5;
  const to = 7;
  const report = await call<{ cuts: number; framesRemoved: number; removedText: string[] }>("delete_transcript_ranges", {
    assetId: asset.id,
    ranges: [{ fromWord: from, toWord: to }],
  });
  const after = (await summary()).totalFrames;
  check(report.cuts >= 1, `ripple cut applied (${report.cuts} range)`);
  check(before - after === report.framesRemoved, `timeline shortened by exactly framesRemoved (${report.framesRemoved})`);
  const expected = Math.round((words[to].end - words[from].start) * fps);
  check(Math.abs(report.framesRemoved - expected) <= 3, `frames removed ≈ word span (${report.framesRemoved} vs ${expected})`);
  check(report.removedText.join(" ").split(/\s+/).length === to - from + 1, `removed text is the 3 words ("${report.removedText[0]}")`);

  console.log("4. tighten_talk: shrink pauses; captions survive on the cut clips...");
  await clearTimeline();
  const clip = (await call<{ clip: { id: string } }>("append_clip", { assetId: asset.id })).clip;
  await call("generate_captions", { clipId: clip.id });
  const beforeTighten = (await summary()).totalFrames;
  const tighten = await call<{
    removed: { type: string; start: number; end: number }[];
    cuts: number;
    framesRemoved: number;
    oldDurationFrames: number;
    newDurationFrames: number;
  }>("tighten_talk", { clipId: clip.id, maxPauseSec: 0.6 });
  const afterTighten = (await summary()).totalFrames;
  check(tighten.removed.some((r) => r.type === "pause"), `pauses found and shrunk (${tighten.removed.length} removals)`);
  check(beforeTighten - afterTighten === tighten.framesRemoved, `timeline shortened by framesRemoved (${tighten.framesRemoved})`);
  check(tighten.newDurationFrames === tighten.oldDurationFrames - tighten.framesRemoved, "report durations are consistent");
  // Captions must have been sliced with the clips: every surviving cue inside its clip.
  const state = await call<{ tracks: { clips: { id: string; captions?: { cues: { startFrame: number; endFrame: number }[] } }[] }[] }>("get_state", {});
  let cueCount = 0;
  let cuesInBounds = true;
  for (const track of state.tracks) {
    for (const c of track.clips) {
      const dur = (await summary()).tracks.flatMap((t) => t.clips).find((x) => x.clipId === c.id)?.durationFrames ?? 0;
      for (const cue of c.captions?.cues ?? []) {
        cueCount++;
        if (cue.startFrame < 0 || cue.endFrame > dur || cue.endFrame <= cue.startFrame) cuesInBounds = false;
      }
    }
  }
  check(cueCount > 0, `captions survived the ripple cuts (${cueCount} cues)`);
  check(cuesInBounds, "every surviving caption cue lies within its clip");

  console.log("5. edit_by_transcript assembles clips from kept text...");
  await clearTimeline();
  // Keep two spans of the real transcript with a gap between them.
  const keepText = `${words.slice(1, 5).map((w) => w.text).join(" ")} ${words.slice(10, 14).map((w) => w.text).join(" ")}`;
  const assembled = await call<{ clipsCreated: string[]; spans: { text: string }[]; matchedWords: number }>("edit_by_transcript", {
    assetId: asset.id,
    keep: keepText,
  });
  check(assembled.clipsCreated.length >= 2, `kept spans became clips (${assembled.clipsCreated.length})`);
  check(assembled.matchedWords === 8, `all 8 kept words matched (got ${assembled.matchedWords})`);
  const finalFrames = (await summary()).totalFrames;
  const spanSec = words[4].end - words[1].start + (words[13].end - words[10].start);
  check(Math.abs(finalFrames - Math.round(spanSec * fps)) < fps, `assembled duration ≈ kept spans (${finalFrames}f vs ~${Math.round(spanSec * fps)}f)`);

  console.log("6. words survive a save → load round-trip (asset-cache merge)...");
  const savePath = join(dataDir, "textedit.aive");
  await call("save_project", { path: savePath });
  await call("load_project", { path: savePath });
  const reloaded = (await call<{ transcript: { words: NumberedWord[] } | null }>("get_transcript", { assetId: asset.id })).transcript;
  check(!!reloaded && reloaded.words.length === words.length, "word-level transcript survived save/load");
  const stateAssets = await call<{ assets: { id: string; transcript?: unknown; transcriptIndexed?: boolean }[] }>("get_state", {});
  const a = stateAssets.assets.find((x) => x.id === asset.id);
  check(!!a?.transcriptIndexed, "live asset carries transcriptIndexed marker");
  check(a?.transcript === undefined, "live asset does NOT carry the heavy transcript (undo stays light)");

  console.log(failures === 0 ? "\nTEXT-EDIT SMOKE TEST PASSED" : `\nTEXT-EDIT SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("TEXT-EDIT SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
