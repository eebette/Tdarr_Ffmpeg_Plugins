# Tdarr FFmpeg Flow Plugins 🎬

Flow plugins for Tdarr that focus on building and executing flexible FFmpeg commands inside flow. 🎯

Improves upon existing tooling by dynamically reordering ffmpeg arguments for optimized transcodes.

## Install 🛠️
Prereqs: `curl` or `wget`, and `tar` (standard on most distros).

1) Run the installer; it downloads the latest plugin bundle from `https://github.com/eebette/Tdarr_Ffmpeg_Plugins` (no git required—curl/wget + tar) and copies only the plugin `index.js` files into Tdarr:
   ```bash
   # Download and run
   ./install_flow_plugins.sh /path/to/tdarr/server
   ```
   ```bash
   # or one-liner:
   bash <(curl -fsSL https://raw.githubusercontent.com/eebette/Tdarr_Ffmpeg_Plugins/refs/heads/master/install_flow_plugins.sh) /path/to/tdarr/server
   ```
   ```bash
   # or as root:
   sudo bash -c 'curl -fsSL https://raw.githubusercontent.com/eebette/Tdarr_Ffmpeg_Plugins/refs/heads/master/install_flow_plugins.sh -o /tmp/install_flow_plugins.sh && bash /tmp/install_flow_plugins.sh /path/to/tdarr/server'
   ```
   Example: `/opt/tdarr/server` ⇒ `/opt/tdarr/server/Tdarr/Plugins/FlowPlugins`.
2) Restart Tdarr so the flows appear in the UI.
3) Wire the plugin into your flow and set up the FFmpeg arguments via upstream nodes/variables.

## How these flows are meant to be used
- Build FFmpeg arguments in earlier steps (maps, codecs, filters, output container) and stash them in `variables.ffmpegCommand`.
- Send only the `index.js` entrypoints to Tdarr; no extra assets are needed.
- Keep filter arguments before stream mappings; the executor will preserve order so FFmpeg accepts the command.

## Plugin catalog 📦
### Command execution
- `ffmpegCommand/Execute`: Runs FFmpeg with arguments built earlier in the flow. Respects per-stream input/output args, mapping, and container settings, and short-circuits when no processing is required.

### Audio
- `audioEAC3Fallback/Audio: Ensure EAC3 Fallback`: Creates an EAC3 copy for TrueHD/DTS audio when missing, skips if AAC/AC3/EAC3/FLAC is already present, and leaves stream ordering/default handling to downstream steps.
- `audioReorder/Reorder Audio Streams`: Reorders audio by codec and/or language preference (dropdown precedence), sets the first non-commentary track as default, and preserves other streams.

### Video
- `videoCodecStandardize/Video: Standardize Codec Name`: Sets video stream titles like `1080p H264 SDR`, `4K HEVC HDR10`, or `4K HEVC Dolby Vision Profile 8.1 (HDR10)` based on resolution, codec, transfer, and Dolby Vision profile. Optional toggle to only update existing metadata (skips if title/handler_name not already set).

### Metadata
- `streamMetadataRemove/Stream Metadata: Remove Handler/Title`: Removes handler_name and title metadata from video and/or audio streams. Toggles for video and audio streams separately, only processes streams that have existing metadata.

### Subtitles
- `subtitleExtractToSrt/Subtitles: Extract/OCR to SRT`: Extracts one subtitle per language and per type (main/commentary/forced), prefers text, OCRs PGS to SRT (using dotnet/PgsToSrt), injects new SRTs as mapped subtitle streams, preserves originals, and avoids duplicate SRTs per language/type (temp files cleaned after mux).
- `subtitleFixEnglish/Subtitles: Fix English OCR`: Cleans English SRTs generated upstream (OCR typos and spacing) before muxing.
- `subtitleLanguageFilter/Filter Subtitles by Language`: Removes subtitle streams not matching a user-provided comma-separated language list, reading language from metadata or stream outputs.
- `subtitleDeduplicate/Deduplicate Subtitles`: Removes duplicate subtitle streams based on language, codec type, and title/handler_name combination. Prefers streams with default disposition, otherwise keeps first occurrence. For MP4 containers, normalizes empty/null/"SubtitleHandler" handler names as equivalent.
- `subtitleConvertToMovText/Subtitles: Convert to mov_text (MP4)`: Converts mapped text subtitles (e.g., SRT/ASS) to mov_text/tx3g so MP4 muxing succeeds and drops image-based subtitles MP4 cannot store.
- `subtitleReorder/Reorder Subtitles`: Reorders subtitle streams by codec and/or language preference (dropdown precedence), keeps the first non-commentary as default, and preserves forced flags.

### Recommended subtitle flow
`Subtitles: Extract/OCR to SRT` → `Subtitles: Fix English OCR` → `Filter Subtitles by Language` (optional) → `Deduplicate Subtitles` (optional) → `Reorder Subtitles` (optional) → `ffmpegCommand/Execute`.

## Typical flow examples 🔄
- Pre-flight node to choose codecs/filters → build `variables.ffmpegCommand.streams` with map/output args → `ffmpegCommand/Execute` to transcode or remux.
- Simple remux: set input arguments (e.g., `-an`, `-sn`), map the desired video/audio/subtitle streams with `copy` codecs, then run `ffmpegCommand/Execute` to produce a new container.
- Filtered encode: add video filters and output codec settings upstream, ensure filters are ordered before `-map`, then let `ffmpegCommand/Execute` run the assembled command.
