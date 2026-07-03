# Releasing & Auto-Update

How to ship a new version of SynthCut so that installed (Windows) users receive it
**automatically**. This is the operator's guide to the auto-update pipeline wired
via `electron-updater` + GitHub Releases. For the design/setup notes see
[`../AUTO_UPDATE_SETUP.md`](../AUTO_UPDATE_SETUP.md).

---

## TL;DR — cut a release

Releases are triggered by **pushing a git tag** — *not* by pushing code to `main`.

```bash
# 1. Bump the version in ALL FOUR package.json files (see list below) to X.Y.Z
# 2. Commit the bump
git commit -am "Release v0.1.2"

# 3. Tag that commit and push the tag
git tag v0.1.2
git push --tags        # (also `git push` your commit)
```

Pushing the `v*` tag starts the **Release** workflow, which builds the Windows
installer + the update feed and publishes a GitHub Release. Installed apps pick it
up on their next launch.

---

## What counts as "a new version"

Three things must line up or users get nothing:

1. **The tag matches `v*`** — e.g. `v0.1.2`. That's the CI trigger.
2. **The `package.json` version equals the tag** (minus the `v`) and is **higher
   than what users have installed.** `electron-updater` compares the version in the
   published `latest.yml` against the running app's version. Same version → no
   update offered. So a tag alone is not enough — you must bump the version too.
3. **The GitHub Release is _published_, not a draft.** `electron-updater` cannot
   see draft releases. (Our workflow already sets `draft: false`.)

### The four version files to bump

Keep these in lockstep — the app's version is `apps/desktop/package.json`:

| File | Package |
|------|---------|
| `package.json` | repo root |
| `packages/core/package.json` | `@aive/core` |
| `packages/mcp/package.json` | `@aive/mcp` |
| `apps/desktop/package.json` | `@aive/desktop` ← **the one the updater compares** |

> Only `apps/desktop/package.json` strictly drives the update check, but bump all
> four together so versions never diverge.

---

## What the CI does (on a `v*` tag)

Defined in [`../.github/workflows/release.yml`](../.github/workflows/release.yml):

1. Checks out **the exact commit the tag points to**.
2. `npm ci` → `npm run build` (core + mcp + renderer).
3. `npm run dist -- --publish never` — electron-builder produces:
   - `SynthCut by Relo <ver>.exe` — the installer
   - `SynthCut by Relo <ver>.exe.blockmap` — the differential-download map
   - `latest.yml` — **the update feed the app reads**
   - `.zip` (portable) + `SHA256SUMS.txt`
4. Attaches **all** of those to a **published** GitHub Release.

> All three of `.exe`, `.exe.blockmap`, and `latest.yml` must be on the Release,
> or auto-update breaks. The workflow globs them explicitly.

---

## How the update reaches users

```
tag push ──► CI builds ──► published GitHub Release (exe + blockmap + latest.yml)
                                        │
        installed app launches ─────────┘
                │
                ├─ reads latest.yml → newer version?
                │        no  → nothing happens
                │        yes → downloads changed chunks in the background
                │              (via .blockmap — not the full ~444 MB)
                │
                └─ "update-downloaded" → dialog "Restart now / Later"
                        Restart now → installs immediately, relaunches
                        Later       → installs on the next quit/launch
```

- Runs **only in the installed/packaged app** (guarded by `app.isPackaged`) — never
  during `npm start`.
- The stable `appId` (`com.relo.synthcut`) means updates upgrade in place — no
  uninstall.
- Unsigned is fine on Windows; SmartScreen only nags on the very first manual
  install, not on self-updates.
- **macOS/Linux:** no packaged build or auto-update yet. Those users run from source
  and update with `git pull && npm run build` (see the README).

---

## Testing an update end-to-end

1. Build + install an **older** version locally (e.g. v0.1.1):
   `npm run dist --workspace @aive/desktop`, then run the installer.
2. Bump to a **higher** version (v0.1.2), tag, and push → let CI publish the Release.
3. Launch the installed **older** app → within a moment it downloads in the
   background → the "Update ready" dialog appears.
4. To watch the process, add `electron-log` and check the log at
   `%APPDATA%\SynthCut by Relo\logs`.

---

## Rolling back

There's no "un-ship." To recover from a bad release: publish a **higher** version
with the fix (e.g. `v0.1.3`). Users move forward to it on next launch. (Deleting the
bad Release stops *new* downloads but doesn't downgrade anyone already updated.)

---

## Who can trigger a release — and branches

See the dedicated section in the README / your notes, but in short: the trigger is
the **tag**, not the branch, and only people with **push access to this repo** can
publish to your users. A tag pushed to a **fork** publishes to that fork, not to you.
