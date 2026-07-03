/**
 * P1-A smoke: the CLIP BPE tokenizer algorithm is correct. We can't run the
 * real CLIP model offline, but the ONLY hand-written piece is the tokenizer —
 * so we verify its algorithm against a CONTROLLED synthetic vocab + merges
 * where the expected ids are known: byte→unicode mapping, regex word split,
 * greedy BPE merging, vocab lookup, and bos/eos/pad to the 77-token context.
 *
 * Run: npx tsx packages/core/scripts/smoke-clip-tokenizer.ts
 */
import { ClipTokenizer } from "../src/media/clipTokenizer.js";
import { cosine } from "../src/media/clip.js";

function main() {
  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  // Synthetic vocab/merges: merge 'a' + 'b</w>' → 'ab</w>'.
  const vocab: Record<string, number> = {
    "<|startoftext|>": 100,
    "<|endoftext|>": 101,
    "a</w>": 1,
    "b</w>": 2,
    "ab</w>": 3,
    "c</w>": 4,
  };
  const merges = ["#version: 0.2", "a b</w>"]; // header line must be ignored
  const tok = new ClipTokenizer(vocab, merges);

  console.log("1. special tokens...");
  check(tok.bos === 100 && tok.eos === 101 && tok.pad === 0, "bos/eos/pad resolved from vocab");

  console.log("2. BPE merge ('ab' → single merged token)...");
  const ab = tok.encode("ab");
  check(ab.ids.slice(0, 3).join(",") === "100,3,101", `'ab' → [bos, ab</w>, eos] (got ${ab.ids.slice(0, 3).join(",")})`);
  check(ab.ids.length === 77, "padded to 77");
  check(ab.mask[0] === 1 && ab.mask[2] === 1 && ab.mask[3] === 0, "attention mask marks real vs pad tokens");

  console.log("3. no merge when separated ('a b' → two tokens)...");
  const aSpaceB = tok.encode("a b");
  check(aSpaceB.ids.slice(0, 4).join(",") === "100,1,2,101", `'a b' → [bos, a</w>, b</w>, eos] (got ${aSpaceB.ids.slice(0, 4).join(",")})`);

  console.log("4. case-folding + unknown chars dropped gracefully...");
  const upper = tok.encode("AB");
  check(upper.ids.slice(0, 3).join(",") === "100,3,101", "uppercase folds to same ids");
  const withUnknown = tok.encode("a z"); // 'z' not in vocab → no id contributed
  check(withUnknown.ids.slice(0, 3).join(",") === "100,1,101", "unknown subword contributes no id, sequence stays valid");

  console.log("5. cosine similarity helper...");
  check(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9, "cosine of identical unit vectors = 1");
  check(Math.abs(cosine([1, 0], [0, 1])) < 1e-9, "cosine of orthogonal vectors = 0");
  check(cosine([1, 0], undefined) === 0, "cosine tolerates missing embedding");

  console.log(failures === 0 ? "\nCLIP-TOKENIZER SMOKE TEST PASSED" : `\nCLIP-TOKENIZER SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
