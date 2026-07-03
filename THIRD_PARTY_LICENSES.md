# Third-Party Licenses & Notices

The AI-Native Video Editor is licensed under the **GNU General Public License v3.0 or later** (see `LICENSE`).
It ships with, or downloads on first use, a number of third-party components.
This file lists them, their licenses, and any obligations they place on
redistribution. Packaged installers include a copy of this file.

> **TL;DR for redistributors**
> - Everything bundled is freely redistributable **except** you should read the
>   **Remotion License** section — Remotion is *source-available, not OSI
>   open-source*, and **companies with 4 or more people need a paid license** to
>   use it. It powers the motion-graphics feature only.
> - **FFmpeg** is bundled as a GPL build and invoked as a separate process. If you
>   redistribute the installer you must make the **corresponding FFmpeg source**
>   available (it is unmodified upstream FFmpeg — see the FFmpeg section).

---

## Bundled in the installer

### FFmpeg / ffprobe
- **Role:** all media decoding, filtering, encoding. Invoked as an external
  subprocess — it is **never linked** into our code. Its GPL license is in any
  case compatible with this project's GPL-3.0 license.
- **Build shipped:** a static GPL build (e.g. gyan.dev or BtbN). Because the
  binary is a GPL build, distributing it carries GPL obligations **for the binary
  itself**: you must offer the corresponding source.
- **License:** GPLv3 (the build); FFmpeg itself is LGPL/GPL.
- **Source:** https://ffmpeg.org/download.html and the build packager's source
  (https://www.gyan.dev/ffmpeg/builds/ or https://github.com/BtbN/FFmpeg-Builds).
  The bundled binaries are unmodified upstream releases.

### whisper.cpp (`whisper-cli` + ggml libraries)
- **Role:** local, offline speech-to-text for captions.
- **License:** MIT — © The ggml authors / Georgi Gerganov.
- **Source:** https://github.com/ggml-org/whisper.cpp (release v1.9.0).

### Whisper ggml model (`ggml-base.en.bin`)
- **Role:** the speech-recognition weights used by whisper.cpp.
- **License:** MIT — derived from OpenAI Whisper (MIT), converted to ggml format
  and distributed by the whisper.cpp project.
- **Source:** https://huggingface.co/ggerganov/whisper.cpp

### YuNet face-detection model (`face_detection_yunet_2023mar.onnx`)
- **Role:** local face tracking for subject-aware auto-reframe.
- **License:** Apache-2.0 — from OpenCV Zoo (© Shiqi Yu, Yuantao Feng et al.).
- **Source:** https://github.com/opencv/opencv_zoo

### ONNX Runtime (`onnxruntime-node`, incl. `onnxruntime.dll`, `DirectML.dll`)
- **Role:** runs the YuNet face model and the CLIP semantic-search model.
  Prebuilt native binaries (no compilation).
- **License:** MIT — © Microsoft Corporation.
- **Source:** https://github.com/microsoft/onnxruntime

### CLIP semantic-search model (`vision.onnx` + `text.onnx` + tokenizer)
- **Role:** local, on-device semantic visual search (text→image and image→image).
  CLIP ViT-B/32, quantized ONNX export + BPE tokenizer (vocab.json / merges.txt).
- **License:** MIT — OpenAI CLIP weights are MIT; the ONNX export is repackaged by
  the Transformers.js project (Xenova) under the same terms.
- **Source:** https://huggingface.co/Xenova/clip-vit-base-patch32 (upstream:
  https://github.com/openai/CLIP).
- **Note:** NOT bundled in the installer — downloaded once on first use into
  `~/.aive/clip` and cached locally (offline thereafter), like the larger Whisper
  models. Override/air-gap via `AIVE_CLIP_DIR` / `AIVE_CLIP_URL`; disable with
  `AIVE_CLIP_DISABLE=1` (search falls back to the model-free perceptual index).

### Noto Sans (`NotoSans-Regular.ttf`)
- **Role:** the bundled font for burned-in text overlays and captions, so they
  render identically on machines without the system fonts.
- **License:** SIL Open Font License, Version 1.1 (see
  `resources/aive/fonts/LICENSE-NotoSans.txt` in the installed app).
- **Source:** https://github.com/googlefonts/noto-fonts

### Electron
- **Role:** the desktop application shell.
- **License:** MIT — © GitHub / OpenJS Foundation. Electron itself bundles
  Chromium (BSD-style) and Node.js (MIT); see Electron's own license manifest
  shipped in the app.

### npm runtime dependencies
All MIT-licensed:
- **react**, **react-dom** — © Meta Platforms, Inc.
- **execa** — © Sindre Sorhus
- **ws** — © Einar Otto Stangvik
- **zod** — © Colin McDonnell
- **nanoid** — © Andrey Sitnik

---

## ⚠️ Remotion — source-available, NOT open-source

- **Packages:** `remotion`, `@remotion/bundler`, `@remotion/renderer` (and their
  `@remotion/*` peers).
- **Role:** renders AI-authored React/Remotion components into motion graphics.
  Used **only** by the motion-graphics feature and isolated to
  `packages/core/src/motion/render.ts`.
- **License:** the **Remotion License** — *source-available, not OSI
  open-source.* Individuals and companies of up to 3 people may use it for free;
  **companies of 4+ people require a paid Remotion Company License.** Review the
  current terms before commercial use or redistribution:
  https://github.com/remotion-dev/remotion/blob/main/LICENSE.md
- **Note:** unlike FFmpeg, Remotion is a *linked dependency*, so its terms flow to
  anyone who redistributes a build that includes it. It is deliberately confined
  to one module and can be swapped for a Puppeteer/Playwright-based renderer if a
  fully-OSI motion-graphics path is required.

---

## Downloaded on first use (NOT in the installer)

These are fetched and cached on the user's machine the first time the relevant
feature runs; they are not shipped in the installer.

### Chrome Headless Shell (via Remotion)
- **Role:** the headless browser Remotion drives to render motion graphics.
- **License:** BSD-style (Chromium) — © The Chromium Authors. Downloaded and
  cached by Remotion's `ensureBrowser()`.

### Additional whisper models
Larger Whisper models (small/medium/large) download on demand from Hugging Face
under the same MIT terms as the bundled `base.en` model, if the user requests
them.
