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

## Typical flow examples 🔄
- Pre-flight node to choose codecs/filters → build `variables.ffmpegCommand.streams` with map/output args → `ffmpegCommand/Execute` to transcode or remux.
- Simple remux: set input arguments (e.g., `-an`, `-sn`), map the desired video/audio/subtitle streams with `copy` codecs, then run `ffmpegCommand/Execute` to produce a new container.
- Filtered encode: add video filters and output codec settings upstream, ensure filters are ordered before `-map`, then let `ffmpegCommand/Execute` run the assembled command.
