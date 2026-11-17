# What's Changed in SpliceWright

This file tracks pending and recently added features, enhancements, and fixes in **SpliceWright** since the last `git push`.

> **Maintenance Rule:** Whenever new features or user-facing changes are implemented, add an entry under **Pending Changes (Since Last Push)**. After a `git push`, refresh this file by moving pushed items to **Recently Pushed** (or resetting the pending section for the next cycle).

---

## Pending Changes (Since Last Push)

### Studio Scene Text Defaults
- Nonempty, optional `scene.defaultTextOverlay` strings now create an initial text overlay spanning the scene, preserving multiline text.
- Editor projects record which scene defaults have been applied. Sync, reopen, and Studio rebuilds preserve edited or deleted overlays instead of duplicating them or overwriting them when Studio's default changes.
- New, unapplied defaults appear in the Studio sync notification. Missing or blank defaults do not add tracks or migration state to older projects.

### Editable Text Overlays
- Added **Add Text** to the timeline toolbar. Text appears on a separate **Text Overlays** track with move, trim, split, delete, hide/show, and undo/redo support.
- Enter multiline text in the Clip Inspector, choose a basic font, size, and colour, and drag it visually in the Program Monitor. The default is bold white text with a black outline for readability.
- Optionally add a coloured background box behind the text, with adjustable transparency; existing overlays remain transparent by default.
- Text stays fixed in output-frame coordinates over still-image camera motion and video playback. Preview and MP4 export share the same Chromium-rendered text artwork, including Unicode, wrapping, and colour independent of the media look.
- Overlays save non-destructively inside the editor project, survive media reconciliation and Studio rebuilds, and remain separate from dialogue captions, audio mixes, and SRT subtitles. Existing projects need no migration.

### Still Image Backgrounds
- Added **Image Background** choices in the Clip Inspector: **Plain (Black)**, **Mottled**, and **Softened Image** (a blurred copy of the selected still).
- Each change prompts **Apply to all images?**, with options for this clip only, all existing image clips, or cancel. Videos and placeholder slates are unaffected.
- Backgrounds stay fixed behind foreground camera motion in the Program Monitor and MP4 export. Settings save per clip in the editor project; existing clips retain black backgrounds until changed.
- Fixed the Program Monitor stretching foreground images when its available space does not match the project's aspect ratio.

### Fit / Stretch Modes & Star Wars Crawl (3D Perspective Scroll)
- **Aspect-Ratio Fit / Stretch Selector (`Clip Inspector`):**
  - Added a dedicated **Fit / Stretch Mode (Aspect Ratio Framing)** dropdown on video/image clips so tall/narrow screenshots (e.g., document captures in a `16:9` project) or wide images in a `9:16` project can be framed independently of camera motion:
    - `1. Fit Inside (Letterbox / Pillarbox — Default)` (`contain`)
    - `2. Stretch to Fill Frame (Stretch Wide 16:9 / Stretch Tall 9:16)` (`stretch-fill`)
    - `3. Fit Full Width (Wide 16:9 — Ideal for Document Scroll)` (`fill-width`) — Scales tall, narrow document captures to full 16:9 width without horizontal distortion so `4a. Pan Top-to-Bottom` scrolls cleanly down the full width of the screen.
    - `4. Fit Full Height (Tall 9:16 — Ideal for Horizontal Pan)` (`fill-height`)
    - `5. Zoom to Fill / Cover (No Black Bars)` (`cover-crop`)
- **Star Wars Crawl (`7. Star Wars Crawl (3D Perspective Scroll)`):**
  - Added **`7. Star Wars Crawl (3D Perspective Scroll)`** (`star-wars-crawl`) to the **Still Image / Camera Motion** dropdown (and automatic inference from `cameraDirection` when `"star wars"` or `"crawl"` is present).
  - **Live Preview (`PreviewPlayer.tsx`):** Extends the 3D perspective stage wrapper above the viewport (`top: '-42%'`, `left: '-6%'`, `right: '-6%'`, `transformOrigin: '50% 100%'`) so when tilted at `25deg`, the projected top edge of the crawl reaches the very top of the Program Monitor without being truncated.
  - **MP4 Export (`ffmpegEngine.ts`):** Maps top perspective corners directly to `y0=0:y1=0` (`interpolation=cubic`) with a `16px` black guard border on left/right so FFmpeg's `perspective` filter never smears top-row text vertically into barcode lines at the top of the exported MP4.
- **Timeline & Monitor Badges:**
  - Displays active Fit/Stretch (`⤢ <fitMode>`) and Camera Motion badges on timeline clips and in the top-left of the Program Monitor.

### Narration First-Word Leveling Fix (`altboundary` + Fast Compressor)
- **Zero-Delay First-Word Gain (`ffmpegEngine.ts`):**
  - Fixed an issue where the first word of a normalized narration clip could sound quiet before jumping up to normal volume even with `Fade In = 0s`.
  - Enabled `b=1` (`altboundary=true`) with shorter `75ms` frames (`dynaudnorm=f=75:g=5:p=0.92:m=8:b=1:s=5`) paired with a fast `4ms`-attack compressor (`acompressor=threshold=-21dB:ratio=2.5:attack=4:release=140:makeup=1.5`) so the very first syllable starts at full leveled volume immediately, and bumps `cacheVersion` so re-running **Level Narration** immediately reloads the updated audio in live preview.

### Single-Clip Media Refresh & In-Place Audio/Image Modification Detection
- **Refresh Single Clip Media Button (`Clip Inspector`):**
  - Added a **`Refresh Clip Media`** button in the **Clip Inspector** header (`MediaBinAndInspector.tsx`) so you can reload just a single selected audio, image, or video clip from disk / `ai-movie.json` (with automatic duration re-probing and cache-busting `?v=<timestamp>`) without syncing or ripple-shifting the rest of the timeline.
- **In-Place File Modification Detection (`computeAiMovieSyncSummary`):**
  - Detects when an existing audio, image, or video file is overwritten or regenerated in-place on disk (`mtimeMs` / duration / path / dialogue text change) and flags it in the **`Sync Studio`** badge (`modifiedMediaCount`).

### Studio Auto-Launch Start Screen Lockout
- **Greyed-Out Start Screen During Studio Launch (`App.tsx`):**
  - When **SpliceWright** is launched from **SpliceWright Studio** (or while a project is loading), the three Start Screen workflow cards are greyed out and disabled with a **"Launching Project from SpliceWright Studio..."** banner so buttons cannot be clicked mid-load.

### Section 8 Interop: Automatic Multi-Scene Audio Spanning (Scenario 2) & OBS Screencast Speed Ramps / Sub-Clips (Scenario 1)
- **Scenario 2 — Automatic Multi-Scene Audio Spanning (`projectManager.ts`):**
  - When Scene $N$ (the **Anchor Scene**) has dialogue/voiceover whose duration exceeds `sceneN.durationSeconds`, and the immediately following scenes ($N+1, N+2, \dots, N+k$) have no dialogue of their own, Scene $N$'s visual clip now stays at `sceneN.durationSeconds` so Scenes $N+1 \dots N+k$ cut visually on `track_video_main` while Scene $N$'s narration plays continuously underneath on `track_audio_dialogue`.
  - Only if Scene $N$'s audio exceeds the combined visual duration of the entire span group ($\sum_{i=0}^{k} \text{scene}_{N+i}.\text{durationSeconds}$) does the **last scene ($N+k$)** extend its still hold so the audio finishes before Scene $N+k+1$ begins.
- **Scenario 1 — Non-Destructive Sub-Clips, `playbackRate` (`0.5x–4x`), `muteSourceAudio` & `segments[]`:**
  - Added support for `sourceInSeconds`, `sourceOutSeconds`, `playbackRate`, `muteSourceAudio`, and `segments[]` on `scene.videos[]` in `ai-movie.json`, plus `playbackRate` and `muteSourceAudio` on `TimelineClip` (`getClipTimelineDuration(clip) = (sourceOut - sourceIn) / (playbackRate || 1.0)`).
  - Added **Playback Speed (`0.5x` – `4.0x`)** and **Mute Source Video Audio** controls in the **Clip Inspector** (`MediaBinAndInspector.tsx`) and `⚡ <rate>x` badges on timeline clips (`TimelineEditor.tsx`).
  - Updated **Split Clip at Playhead** and trim handles to account for `playbackRate` while keeping split sub-clips assigned to the same `sceneId`.
  - Updated live preview (`PreviewPlayer.tsx`) and FFmpeg export (`ffmpegEngine.ts`) to apply `setpts=PTS/${playbackRate}` on speed-ramped video clips and include unmuted source video audio with `atempo` when `muteSourceAudio === false`.
- **OBS `.mkv` Auto-Remux & Chapter Marker Sub-Clip Import (`hardware.ts`, `main.ts`, `App.tsx`):**
  - Importing an `.mkv` recording automatically remuxes it losslessly to `assets/video/<name>.mp4` (`-map 0 -c copy`).
  - Inspects `ffprobe -show_chapters` on imported video files and offers 1-click placement of non-destructive sub-clips for each embedded OBS Chapter Marker onto the timeline.

### Dedicated 2-Row Header + Action Ribbon, Scene-Assigned Imports & `exports/studio-updates.json`
- **Dedicated 2-Row Header + Action Ribbon (`App.tsx`):**
  - Split the top header into two clean rows so buttons never crowd or clip off the right edge of the window when **SpliceWright** is not maximized:
    - **Row 1 (Project Identity & Status):** Brand, Project Title, Mode Badge, Aspect Ratio selector, Look Preset selector, and the **Sync Studio** (or **Convert to Studio Project**) button.
    - **Row 2 (Dedicated Action Ribbon):** **Open Project**, **Standalone Folder**, **Stitch Chapters**, Hardware Encoder badge (`h264_amf`), **Buy Me a Coffee** (with full 4-sided borders), **2nd Screen**, **Save**, and **Export MP4**.
- **Editor $\rightarrow$ Studio Update Outbox (`exports/studio-updates.json`) & Scene Assignment Prompt:**
  - When importing Video/Image, Voiceover, or SFX into a **SpliceWright Studio** project, **SpliceWright** now prompts to assign the imported file to a specific **Scene (`Scene 1..N`)**, **Create a New Scene**, or import as a **Project-Wide Shared Asset** (defaulting to the scene at the current Playhead position).
  - Stores scene-assigned files directly in `scenes/<sceneId>/videos/` or `audio/<sceneId>/`, attaches them to that scene's clip & Take Switcher, and writes **`exports/studio-updates.json`** (`writeStudioUpdatesManifest` in `projectManager.ts`) recording `addedAssets[]` and `sceneTimelineUpdates[]` so **SpliceWright Studio** knows what assets were added, when, and where.
  - Protected user-imported scene selections during **Sync Studio** (`mergeNewAssetsFromAiMovie`) and fixed normalized `[Norm]` audio mtime comparison so normalized dialogue is never falsely flagged as `10 updated`.
- **Convert Standalone to SpliceWright Studio Project (`Convert to Studio Project`):**
  - When working in **Standalone Folder Mode** (where `ai-movie.json` does not exist yet), clicking **`Convert to Studio Project`** creates `ai-movie.json`, extracts `scenes/scene-N/first-frame.png` thumbnails via FFmpeg, and switches into `ai-movie.json R/O` monitoring mode.
- **Section 8.3 & 8.4 Alignment (`v0.0.71–v0.0.72`):**
  - Updated multi-character dialogue take deduplication (`(characterId || '') + ':' + dialogueLine.toLowerCase()`) so only the single `status === 'approved'` take (or the latest take when none is marked approved yet) is placed per distinct dialogue line.
  - Restores `fitMode` and `kenBurns` persisted by **SpliceWright Studio** (`v0.0.72+`) on `scene.videos[]` or `scene.properties` when rebuilding or syncing from `ai-movie.json`.

### Stale Takes, Archived Media, Unlinked Audio & Poster Validation (Section 7.5, Studio `v0.0.83`)
- **Reconcile on every load and Studio sync (`reconcileProjectMedia`, `projectManager.ts`):**
  - Scene clips whose take is missing, archived (`archive/`) or undefined in `assets[]` are re-resolved from `ai-movie.json` (preferred take, else latest take, else poster, else slate), with `sourceIn`/`sourceOut` reset and later scenes rippled to fit. A still-valid saved selection is never overridden.
  - Stale ids are dropped from `availableTakeAssetIds`, `sequence[].selectedVideo`, `alternateVideos`, `posterFrame` and `dialogue`; only media that exists is registered in `assets[]`.
  - A repaired scene with an empty dialogue track gets its eligible dialogue back (one take per distinct line after deduplication).
- **`scene.audioAssets[]` is the only source of scene audio:** loose files in `audio/<scene-id>/` are no longer scanned, registered or placed (this also affects silent-continuation detection). Missing/archived audio files are skipped before deduplication so an older valid take can still be chosen.
- **Poster validation:** a `first-frame.<ext>` must have a PNG/JPEG/WebP file signature; an MP4 saved as an image is treated as missing and falls back to the slate.
- **"Missing media" state:** clips whose media cannot be recovered are flagged `missingMedia` and show a warning in the timeline and Preview Monitor instead of rendering blank (relink dialog not yet implemented).

---

## Recently Pushed (`838da51` — Initial v1.0.0 Public Release)

- Initial public release of **SpliceWright** (`v1.0.0`) with multi-track timeline editing, `ai-movie.json` live file-watcher sync, Ken Burns camera motion, auto-ducking BGM, EBU R128 / dynamic audio leveling, Dual Monitor (`2nd Screen`) mode, `.SRT` & `.FCPXML` export, and Master Chapter Stitcher.
- Fixed macOS `512x512` icon sizing and Linux `.deb` maintainer metadata for cross-platform GitHub Actions release builds.
