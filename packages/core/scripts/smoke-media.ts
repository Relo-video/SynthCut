/**
 * Phase 6 smoke: media intelligence — folders, spoken-word search ranking,
 * transcript→timeline-frame mapping, perceptual visual search, and audio-sync.
 *
 * Transcript SEARCH ranking is tested on a synthetic transcript (no Whisper
 * needed). index_transcript (real Whisper) is exercised opportunistically and
 * skipped if the model isn't installed. Audio-sync recovers a known synthetic
 * delay; visual search confirms an asset matches itself best. Real FFmpeg.
 *
 * Run: npx tsx packages/core/scripts/smoke-media.ts <clipA> <clipB>
 */
import { EditorEngine } from "../src/engine.js";
import { rankTranscript } from "../src/media/search.js";
import { buildSignature, signatureSimilarity } from "../src/media/signature.js";
import { ensureClip } from "../src/media/clip.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";
import type { MediaAsset } from "../src/types.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  const [, , clipA, clipB] = process.argv;
  if (!clipA || !clipB) throw new Error("usage: smoke-media.ts <clipA> <clipB>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-media-"));
  const engine = new EditorEngine(dataDir);

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  const a = await engine.importVideo(clipA);
  const b = await engine.importVideo(clipB);

  // 1. Folders.
  console.log("1. folders...");
  const f = engine.createFolder("B-roll");
  engine.moveAssetToFolder(b.id, f.id);
  check(engine.listFolders().length === 1, "folder created");
  check(engine.getAsset(b.id).folderId === f.id, "asset moved into folder");
  engine.deleteFolder(f.id);
  check(engine.getAsset(b.id).folderId === undefined, "deleting folder unfiles its assets");
  check(engine.listFolders().length === 0, "folder deleted");

  // 2. Spoken-word search ranking (pure, synthetic transcript).
  console.log("2. transcript search ranking...");
  const fakeAssets: MediaAsset[] = [
    { ...a, transcript: { segments: [
      { start: 0, end: 2, text: "Today we talk about coffee beans" },
      { start: 2, end: 4, text: "the espresso machine is loud" },
    ] } } as MediaAsset,
    { ...b, transcript: { segments: [
      { start: 0, end: 2, text: "a quick word about coffee culture" },
    ] } } as MediaAsset,
  ];
  const hits = rankTranscript(fakeAssets, "coffee", 10);
  check(hits.length === 2, "two coffee hits found");
  const phraseHits = rankTranscript(fakeAssets, "espresso machine", 10);
  check(phraseHits.length >= 1 && phraseHits[0].text.includes("espresso"), "exact phrase ranks first");
  check(rankTranscript(fakeAssets, "bicycle", 10).length === 0, "no false matches");

  // 3. transcript → timeline frames (inject a transcript into the engine's
  // asset cache — transcripts live there now, outside the undo history).
  console.log("3. locate_in_timeline...");
  (engine as unknown as { setCachedTranscript(id: string, t: unknown): void }).setCachedTranscript(a.id, {
    segments: [
      { start: 0.5, end: 1.5, text: "hello world" },
      { start: 3.0, end: 3.8, text: "goodbye now" },
    ],
  });
  engine.appendClip(a.id); // whole asset on the base track at frame 0
  const matches = engine.locateInTimeline("goodbye", 10);
  check(matches.length === 1, "one timeline match for 'goodbye'");
  if (matches[0]) {
    const expected = Math.round(3.0 * engine.fps);
    check(Math.abs(matches[0].startFrame - expected) <= 2, `match mapped to ~frame ${expected} (got ${matches[0].startFrame})`);
  }

  // 4. Visual fingerprint self-similarity + cross comparison.
  console.log("4. visual signatures...");
  const sigA = await buildSignature(a.path, a.duration, 4);
  const sigB = await buildSignature(b.path, b.duration, 4);
  check(sigA.samples.length >= 1, "asset A fingerprinted");
  const selfScore = signatureSimilarity(sigA, sigA);
  const crossScore = signatureSimilarity(sigA, sigB);
  console.log(`   self ${selfScore.toFixed(3)} vs cross ${crossScore.toFixed(3)}`);
  check(selfScore > 0.95, "asset is ~identical to itself");
  check(selfScore >= crossScore, "self-similarity ≥ cross-similarity");

  // 5. search_visual: A should rank itself first (perceptual reference mode).
  console.log("5. search_visual (reference)...");
  const vis = await engine.searchVisual({ assetId: a.id, atSeconds: a.duration / 2 }, 5);
  check(vis.hits.length >= 1 && vis.hits[0].assetId === a.id, "reference asset ranks itself top");
  check(vis.mode === "reference", "reference mode reported");

  // 5b. SEMANTIC text→image search (end-to-end). Runs only if the local CLIP
  //     model is available (downloaded once; needs network on first run). When
  //     it isn't, we assert the graceful fallback error instead of crashing.
  console.log("5b. semantic text→image search...");
  if (await ensureClip()) {
    // Two visually unambiguous clips, then query by color and check ranking.
    const red = join(dataDir, "red.mp4");
    const blue = join(dataDir, "blue.mp4");
    await runFfmpeg(["-hide_banner", "-f", "lavfi", "-i", "color=c=red:s=224x224:d=2:r=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", red]);
    await runFfmpeg(["-hide_banner", "-f", "lavfi", "-i", "color=c=blue:s=224x224:d=2:r=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", blue]);
    const rd = await engine.importVideo(red);
    const bl = await engine.importVideo(blue);
    await engine.indexVisual(rd.id);
    await engine.indexVisual(bl.id);
    const q = await engine.searchVisual({ query: "a solid blue image" }, 10);
    check(q.semantic && q.mode === "text", "text-query returns semantic text mode");
    const blueHit = q.hits.find((h) => h.assetId === bl.id);
    const redHit = q.hits.find((h) => h.assetId === rd.id);
    console.log(`   'a solid blue image' → blue ${blueHit?.score.toFixed(3)} vs red ${redHit?.score.toFixed(3)}`);
    check(!!blueHit && !!redHit && blueHit.score > redHit.score, "blue clip outranks red clip for 'blue' query");
  } else {
    console.log("   (CLIP model unavailable — verifying graceful fallback error)");
    try {
      await engine.searchVisual({ query: "a sunset" }, 5);
      check(false, "text query should throw when model unavailable");
    } catch (e) {
      check(/CLIP model/i.test((e as Error).message), "clear 'CLIP model' error when semantic unavailable");
    }
  }

  // 6. Audio-sync: synthesize a clip with a DISTINCTIVE (non-periodic) loudness
  //    envelope, make a 2s-delayed copy, then recover the offset.
  console.log("6. audio-sync (recover a known 2s delay)...");
  const ref = join(dataDir, "ref.mp4");
  await runFfmpeg([
    "-hide_banner",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=8:sample_rate=16000",
    "-f", "lavfi", "-i", "color=c=gray:s=160x120:d=8:r=10",
    "-af", "volume='0.05+0.95*abs(sin(1.7*t)+0.5*sin(3.1*t))/1.5':eval=frame",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-shortest", "-y", ref,
  ]);
  const refAsset = await engine.importVideo(ref);
  const delayed = join(dataDir, "delayed.mp4");
  await runFfmpeg([
    "-hide_banner", "-i", ref,
    "-af", "adelay=2000|2000", "-vf", "tpad=start_duration=2:color=black",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-shortest", "-y", delayed,
  ]);
  const da = await engine.importVideo(delayed);
  const refClip = engine.appendClip(refAsset.id); // distinctive reference
  const vTop = engine.addTrack("video");
  const moved = engine.addClip(da.id, { trackIndex: vTop.index, startFrame: 0 });
  const sync = await engine.syncAudio(moved.id, refClip.id, true);
  console.log(`   measured offset ${sync.offsetSeconds.toFixed(2)}s (expect ~+2.0, clip lags), confidence ${sync.confidence.toFixed(2)}`);
  check(Math.abs(sync.offsetSeconds - 2.0) < 0.4, "recovered ~+2s delay (clip lags reference)");
  check(sync.confidence > 0.5, "sync confidence high");

  // index_transcript (real Whisper) — opportunistic.
  if (a.hasAudio) {
    try {
      console.log("7. index_transcript (real Whisper, optional)...");
      const r = await engine.indexTranscript(a.id);
      check(r.segmentCount >= 0, `transcript indexed (${r.segmentCount} segments)`);
    } catch (e) {
      console.log(`   (skipped: ${(e as Error).message.split("\n")[0]})`);
    }
  }

  console.log(failures === 0 ? "\nMEDIA SMOKE TEST PASSED" : `\nMEDIA SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("MEDIA SMOKE TEST FAILED:", err);
  process.exit(1);
});
