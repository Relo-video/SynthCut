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
      el.dataset.path = path;
      el.src = this.fileUrl(path);
      el.load();
    }
    return el;
  }

  /** Drive an element toward `srcTime`, correcting drift sparingly while playing. */
  sync(el: HTMLVideoElement, o: SyncOpts): void {
    el.playbackRate = o.rate > 0 ? o.rate : 1;
    el.muted = o.muted || o.volume <= 0;
    el.volume = clamp01(o.volume);
    if (!Number.isFinite(o.srcTime)) return;

    if (o.playing) {
      if (el.paused) {
        this.safeSeek(el, o.srcTime);
        void el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - o.srcTime) > 0.08) {
        // Re-sync only on meaningful drift — constant reseeking would stutter.
        this.safeSeek(el, o.srcTime);
      }
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - o.srcTime) > 0.02) this.safeSeek(el, o.srcTime);
    }
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
