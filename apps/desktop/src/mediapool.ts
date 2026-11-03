// A small pool of hidden <video> decoders the compositor draws from. One element
// is bound to one clip at a time (keyed by clipId) so seeking/decoding state is
// reused frame-to-frame; a <video> decodes audio-only assets too, so the same
// pool feeds both the canvas (video frames) and the audio mix. The pool is
// capped — only a handful of clips are ever live at one playhead (one per track,
// two during a transition overlap) — and least-recently-used clips are evicted.

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export interface SyncOpts {
  /** Source time (seconds) this clip should be at. */
  srcTime: number;
  /** Master transport state. */
  playing: boolean;
  /** Clip speed. */
  rate: number;
  /** Linear volume 0..1 (already includes fades); 0 + muted when inaudible. */
  volume: number;
  muted: boolean;
}

export class MediaPool {
  private readonly host: HTMLElement;
  private readonly fileUrl: (path: string) => string;
  private readonly onSeeked: () => void;
  private readonly cap: number;
  private readonly byClip = new Map<string, HTMLVideoElement>();
  /** clipIds ordered oldest→newest for LRU eviction. */
  private readonly lru: string[] = [];
  /** clipIds acquired in the current frame (protected from eviction/pause). */
  private used = new Set<string>();
  private readonly starting = new WeakSet<HTMLVideoElement>();
  private readonly frames = new WeakMap<HTMLVideoElement, HTMLCanvasElement>();

  constructor(host: HTMLElement, fileUrl: (path: string) => string, onSeeked: () => void, cap = 8) {
    this.host = host;
    this.fileUrl = fileUrl;
    this.onSeeked = onSeeked;
    this.cap = cap;
  }

  /** Start a new frame: forget which clips were touched last frame. */
  beginFrame(): void {
    this.used = new Set();
  }

  /** Get (or bind) the decoder element for a clip, pointed at `path`. */
  acquire(clipId: string, path: string): HTMLVideoElement {
    this.used.add(clipId);
    this.touch(clipId);

    let el = this.byClip.get(clipId);
    if (!el) {
      el = this.evictOrCreate();
      el.dataset.clipId = clipId;
      this.byClip.set(clipId, el);
    }
    if (el.dataset.path !== path) {
      this.frames.delete(el);
      el.dataset.path = path;
      el.src = this.fileUrl(path);
      el.load();
    }
    return el;
  }

  /** Drive an element toward `srcTime`, correcting drift sparingly while playing. */
  sync(el: HTMLVideoElement, o: SyncOpts): void {
    const rate = o.rate > 0 ? o.rate : 1;
    if (el.playbackRate !== rate) el.playbackRate = rate;
    el.muted = o.muted || o.volume <= 0;
    el.volume = clamp01(o.volume);
    if (!Number.isFinite(o.srcTime)) return;

    if (o.playing) {
      if (el.paused) {
        // play() is asynchronous. Re-seeking on every RAF while it is pending
        // can continually restart the decoder before it produces a frame.
        if (this.starting.has(el)) return;
        if (Math.abs(el.currentTime - o.srcTime) > 0.02) this.safeSeek(el, o.srcTime);
        this.starting.add(el);
        void el.play().catch(() => {}).finally(() => this.starting.delete(el));
      } else if (!el.seeking && Math.abs(el.currentTime - o.srcTime) > 0.25) {
        // Re-sync only on meaningful drift — constant reseeking would stutter.
        this.safeSeek(el, o.srcTime);
      }
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - o.srcTime) > 0.02) this.safeSeek(el, o.srcTime);
    }
  }

  /** Hold the last decoded picture while seeking/buffering instead of flashing
   * the compositor's black background whenever readyState temporarily drops. */
  frame(el: HTMLVideoElement): HTMLCanvasElement | undefined {
    let frame = this.frames.get(el);
    if (!el.seeking && el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0) {
      const next = frame ?? document.createElement("canvas");
      if (next.width !== el.videoWidth) next.width = el.videoWidth;
      if (next.height !== el.videoHeight) next.height = el.videoHeight;
      const ctx = next.getContext("2d");
      if (ctx) {
        try {
          ctx.drawImage(el, 0, 0);
          frame = next;
          this.frames.set(el, next);
        } catch { /* retain the previous picture until a new frame is available */ }
      }
    }
    return frame;
  }

  /** Pause every element not acquired in the current frame (it left the playhead). */
  endFrame(): void {
    for (const [clipId, el] of this.byClip) {
      if (!this.used.has(clipId) && !el.paused) el.pause();
    }
  }

  /** Pause all decoders (transport stop / empty timeline). */
  pauseAll(): void {
    for (const el of this.byClip.values()) if (!el.paused) el.pause();
  }

  /** Tear down: remove every element from the DOM. */
  destroy(): void {
    for (const el of this.byClip.values()) {
      el.pause();
      el.removeAttribute("src");
      el.load();
      el.remove();
    }
    this.byClip.clear();
    this.lru.length = 0;
  }

  private safeSeek(el: HTMLVideoElement, srcTime: number): void {
    // Let an in-flight decode complete; scrubbing will catch up on seeked.
    if (el.seeking) return;
    try {
      el.currentTime = Math.max(0, srcTime);
    } catch {
      /* seeking before metadata — onSeeked / readiness will catch up */
    }
  }

  private touch(clipId: string): void {
    const i = this.lru.indexOf(clipId);
    if (i >= 0) this.lru.splice(i, 1);
    this.lru.push(clipId);
  }

  /** Reuse the least-recently-used idle element if at capacity, else make one. */
  private evictOrCreate(): HTMLVideoElement {
    if (this.byClip.size >= this.cap) {
      const victim = this.lru.find((id) => !this.used.has(id));
      if (victim) {
        const el = this.byClip.get(victim)!;
        this.byClip.delete(victim);
        this.lru.splice(this.lru.indexOf(victim), 1);
        el.pause();
        this.frames.delete(el);
        delete el.dataset.clipId;
        delete el.dataset.path;
        el.removeAttribute("src");
        el.load();
        return el;
      }
    }
    return this.create();
  }

  private create(): HTMLVideoElement {
    const el = document.createElement("video");
    el.playsInline = true;
    el.preload = "auto";
    el.muted = true;
    el.crossOrigin = "anonymous";
    el.addEventListener("seeked", this.onSeeked);
    el.addEventListener("loadeddata", this.onSeeked);
    this.host.appendChild(el);
    return el;
  }
}
