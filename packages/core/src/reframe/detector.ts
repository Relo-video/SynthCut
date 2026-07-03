import { mkdir, access } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import ort from "onnxruntime-node";

/**
 * Face detection with YuNet (OpenCV Zoo, Apache-2.0) via onnxruntime-node.
 * Used by the subject-tracking auto-reframe so a person stays in frame when
 * cropping 16:9 → 9:16. Runs fully locally; the model (~230 KB) is downloaded
 * once and cached. No AGPL components (YuNet is Apache-2.0, ORT is MIT).
 */

/** Fixed input size baked into the YuNet 2023mar graph. */
const INPUT_SIZE = 640;
const STRIDES = [8, 16, 32] as const;

const MODEL_FILE = "face_detection_yunet_2023mar.onnx";
const MODEL_URL =
  "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/" + MODEL_FILE;

/** A detected face box in the (square, letterboxed) 640×640 detector space. */
export interface DetFace {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

function modelsDir(): string {
  return process.env.AIVE_MODELS_DIR || join(homedir(), ".aive", "models");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Ensure the YuNet ONNX model is present locally; download on first use. */
export async function ensureYunetModel(): Promise<string> {
  if (process.env.AIVE_YUNET_MODEL) {
    if (!(await exists(process.env.AIVE_YUNET_MODEL))) {
      throw new Error(`AIVE_YUNET_MODEL points at a missing file: ${process.env.AIVE_YUNET_MODEL}`);
    }
    return process.env.AIVE_YUNET_MODEL;
  }
  const dir = modelsDir();
  const dest = join(dir, MODEL_FILE);
  if (await exists(dest)) return dest;

  await mkdir(dir, { recursive: true });
  process.stderr.write(`[reframe] downloading YuNet face model …\n`);
  const res = await fetch(MODEL_URL, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download YuNet model (${res.status} ${res.statusText})`);
  }
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, dest);
  return dest;
}

function sigmoidClamp(v: number): number {
  // YuNet's cls/obj heads are already probabilities; just guard the range.
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Intersection-over-union of two boxes. */
function iou(a: DetFace, b: DetFace): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy non-max suppression, highest score first. */
function nms(faces: DetFace[], iouThreshold = 0.3): DetFace[] {
  const sorted = [...faces].sort((p, q) => q.score - p.score);
  const kept: DetFace[] = [];
  for (const f of sorted) {
    if (kept.every((k) => iou(k, f) < iouThreshold)) kept.push(f);
  }
  return kept;
}

/** Subject-tracking face detector. Create once, reuse across many frames. */
export class FaceDetector {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async create(): Promise<FaceDetector> {
    const modelPath = await ensureYunetModel();
    const session = await ort.InferenceSession.create(modelPath);
    return new FaceDetector(session);
  }

  /** The square side length frames must be letterboxed to before `detect`. */
  static get inputSize(): number {
    return INPUT_SIZE;
  }

  /**
   * Detect faces in a 640×640 RGB frame (row-major, 3 bytes/pixel). Returns
   * boxes in detector-space coordinates, sorted by score (highest first).
   */
  async detect(rgb: Uint8Array, scoreThreshold = 0.6): Promise<DetFace[]> {
    const n = INPUT_SIZE * INPUT_SIZE;
    if (rgb.length !== n * 3) {
      throw new Error(`detect() expects a ${INPUT_SIZE}x${INPUT_SIZE} RGB frame (${n * 3} bytes), got ${rgb.length}`);
    }
    // YuNet wants BGR planar (NCHW), raw 0..255, no normalization.
    const chw = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      const r = rgb[i * 3];
      const g = rgb[i * 3 + 1];
      const b = rgb[i * 3 + 2];
      chw[i] = b; // B plane
      chw[n + i] = g; // G plane
      chw[2 * n + i] = r; // R plane
    }
    const input = new ort.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const out = await this.session.run({ input });

    const faces: DetFace[] = [];
    for (const s of STRIDES) {
      const cls = out[`cls_${s}`].data as Float32Array;
      const obj = out[`obj_${s}`].data as Float32Array;
      const bbox = out[`bbox_${s}`].data as Float32Array;
      const grid = INPUT_SIZE / s;
      for (let row = 0; row < grid; row++) {
        for (let col = 0; col < grid; col++) {
          const idx = row * grid + col;
          const score = Math.sqrt(sigmoidClamp(cls[idx]) * sigmoidClamp(obj[idx]));
          if (score < scoreThreshold) continue;
          const cx = (col + bbox[idx * 4]) * s;
          const cy = (row + bbox[idx * 4 + 1]) * s;
          const w = Math.exp(bbox[idx * 4 + 2]) * s;
          const h = Math.exp(bbox[idx * 4 + 3]) * s;
          faces.push({ x: cx - w / 2, y: cy - h / 2, w, h, score });
        }
      }
    }
    return nms(faces).sort((p, q) => q.score - p.score);
  }
}
