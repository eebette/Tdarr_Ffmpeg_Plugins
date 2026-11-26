#!/usr/bin/env bash
# Run plugin tests inside Tdarr image: same node, tdarr-ffmpeg, ffprobe as prod.
#
#   tests/run.sh                       all layers
#   tests/run.sh unit pipeline         chosen layers (unit | pipeline | integration | combos)
#   tests/run.sh integration -- --test-name-pattern 'cover'   extra node args after --
#
# Env: TDARR_IMAGE (default ghcr.io/haveagitgat/tdarr:latest), KEEP_WORK=dir (keep media + outputs)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
image="${TDARR_IMAGE:-ghcr.io/haveagitgat/tdarr:latest}"
commit="$(tr -d '[:space:]' < "$here/UPSTREAM_COMMIT")"
cache="$here/.cache/upstream-$commit"

# Upstream Tdarr_Plugins at pinned commit: FlowHelpers, methods, community plugins.
if [[ ! -d "$cache/FlowPlugins" ]]; then
  echo "Fetching HaveAGitGat/Tdarr_Plugins@$commit"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://codeload.github.com/HaveAGitGat/Tdarr_Plugins/tar.gz/$commit" -o "$tmp/up.tar.gz"
  mkdir -p "$tmp/x" "$cache"
  tar -xzf "$tmp/up.tar.gz" -C "$tmp/x" --strip-components=1 --wildcards '*/FlowPlugins' '*/methods'
  mv "$tmp/x/FlowPlugins" "$tmp/x/methods" "$cache/"
fi

layers=()
node_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift; node_args=("$@"); break ;;
    unit|pipeline|integration|combos) layers+=("$1"); shift ;;
    *) echo "unknown layer: $1" >&2; exit 2 ;;
  esac
done
[[ ${#layers[@]} -eq 0 ]] && layers=(unit pipeline integration combos)
globs=()
for l in "${layers[@]}"; do globs+=("tests/$l/*.test.js"); done

work_mount=(--tmpfs /work:exec,mode=1777)
if [[ -n "${KEEP_WORK:-}" ]]; then
  mkdir -p "$KEEP_WORK"
  work_mount=(-v "$(cd "$KEEP_WORK" && pwd)":/work)
fi

# Tree = upstream + this repo's plugins on top, same as install_flow_plugins.sh.
# label=disable: bind mounts readable under SELinux, no relabel of repo.
exec docker run --rm --init --network none \
  --user "$(id -u):$(id -g)" --security-opt label=disable \
  --entrypoint bash \
  "${work_mount[@]}" \
  -e HOME=/work -e TDARR_TREE=/work/tree -e TDARR_WORK=/work \
  -v "$repo":/repo:ro -v "$cache":/upstream:ro -w /repo \
  "$image" -c '
    set -e
    rm -rf /work/tree && mkdir -p /work/tree
    cp -r /upstream/FlowPlugins /upstream/methods /work/tree/
    cp -r /repo/FlowPlugins/. /work/tree/FlowPlugins/
    exec node --test "$@"
  ' _ "${node_args[@]}" "${globs[@]}"
