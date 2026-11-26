#!/usr/bin/env python3
"""Harvest distinct stream layouts from a media library as anonymized ffprobe fixtures.

Read-only: runs ffprobe on each file, nothing else.

    find /media -name '*.mkv' -o -name '*.mp4' | harvest_probes.py | gzip -9n > library-layouts.json.gz
    harvest_probes.py --ffprobe "docker exec -i tdarr ffprobe" < paths.txt > layouts.json
    harvest_probes.py --reduce layouts.json > smaller.json      re-merge older harvest

Output: [{"count": N, "container": "mkv", "streams": [...]}], most common first.
Kept per stream: only fields plugins read. Dropped: paths, file names, durations, sizes.
Titles + attachment names: words replaced by per-file placeholders (x1, x2...) unless
plugin logic keys on them (commentary, codec names, forced...). Same word -> same
placeholder inside one file, so title equality between streams survives.
Merged as one layout: files differing only in resolution class, bitrates, wording.
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

KEEP_WORDS = set("""
commentary narration descriptive director producer writer compat compatibility compatible
truehd dts hd ma dtshd ac3 eac3 dd ddp atmos surround stereo mono aac flac opus pcm lpcm
forced sdh signs songs full dialogue cc sub subs subtitles dub dubtitles dolby vision dovi
srt ass pgs vobsub text image original default hi
""".split())
STREAM_KEYS = (
    "index", "codec_name", "codec_long_name", "codec_type", "codec_tag_string", "profile",
    "channels", "channel_layout", "bit_rate", "width", "height", "color_transfer",
)
TAG_KEYS = ("language", "title", "handler_name", "filename", "mimetype")


def anon_text(text):
    """:return: text with non-logic words replaced by stable hashes"""
    def word(match):
        raw = match.group(0)
        low = raw.lower()
        if low in KEEP_WORDS or re.fullmatch(r"\d+(\.\d+)?", low):
            return low
        return "x" + hashlib.sha1(low.encode()).hexdigest()[:5]
    return " ".join(word(m) for m in re.finditer(r"[^\W_]+(?:\.\d+)?", text))


def anon_filename(name):
    """:return: hashed stem, real extension"""
    stem, ext = os.path.splitext(name)
    return "x" + hashlib.sha1(stem.lower().encode()).hexdigest()[:5] + ext.lower()


def reduce_stream(stream):
    """:return: stream with only plugin-relevant, anonymized fields"""
    out = {k: stream[k] for k in STREAM_KEYS if k in stream}
    if "bit_rate" in out:
        out["bit_rate"] = str(round(int(out["bit_rate"]), -4)) if str(out["bit_rate"]).isdigit() else out["bit_rate"]
    flags = {k: v for k, v in (stream.get("disposition") or {}).items() if v}
    out["disposition"] = dict({"default": 0, "forced": 0, "comment": 0, "attached_pic": 0}, **flags)
    tags = {}
    for key, value in (stream.get("tags") or {}).items():
        low = key.lower()
        if low not in TAG_KEYS:
            continue
        if low in ("title", "handler_name"):
            value = anon_text(value)
        elif low == "filename":
            value = anon_filename(value)
        tags[low] = value
    if tags:
        out["tags"] = tags
    side = sorted({d.get("side_data_type", "") for d in stream.get("side_data_list") or []} - {""})
    if side:
        out["side_data_list"] = [{"side_data_type": s} for s in side]
    return out


LOSSLESS = ("truehd", "mlp", "flac", "dts", "alac")


def canonical(streams):
    """Second pass: fold away detail no plugin branches on, so layouts merge.

    :return: streams with per-file placeholders, bucketed bitrates/resolution
    """
    names = {}

    def rename(token, prefix):
        return names.setdefault((prefix, token), "%s%d" % (prefix, 1 + sum(1 for k in names if k[0] == prefix)))

    out = []
    for stream in streams:
        stream = json.loads(json.dumps(stream))
        kind = stream.get("codec_type")
        if kind == "video":
            stream.pop("bit_rate", None)
            height = stream.get("height") or 0
            if not stream["disposition"].get("attached_pic") and height:
                stream["width"], stream["height"] = next(
                    (w, h) for limit, w, h in ((1200, 3840, 2160), (800, 1920, 1080), (500, 1280, 720), (0, 720, 480)) if height > limit)
            elif height:
                stream["width"], stream["height"] = 600, 900
        elif kind == "audio" and str(stream.get("bit_rate", "")).isdigit():
            if stream.get("codec_name") in LOSSLESS or str(stream.get("codec_name", "")).startswith("pcm"):
                stream.pop("bit_rate")
            else:
                stream["bit_rate"] = str(max(64000, round(int(stream["bit_rate"]) / 64000) * 64000))
        else:
            stream.pop("bit_rate", None)
        tags = stream.get("tags") or {}
        for key in ("title", "handler_name"):
            if key in tags:
                tags[key] = " ".join(rename(w, "x") if re.fullmatch(r"x[0-9a-f]{5}", w) else w for w in tags[key].split())
        if "filename" in tags:
            stem, ext = os.path.splitext(tags["filename"])
            tags["filename"] = rename(stem, "f") + ext
        out.append(stream)
    return out


def merge(layouts):
    """:return: layouts re-keyed on canonical form, counts summed, most common first"""
    merged = {}
    for item in layouts:
        streams = canonical(item["streams"])
        key = json.dumps([item["container"], streams], sort_keys=True)
        merged.setdefault(key, {"count": 0, "container": item["container"], "streams": streams})["count"] += item["count"]
    return sorted(merged.values(), key=lambda l: (-l["count"], json.dumps(l["streams"], sort_keys=True)))


def probe(ffprobe, path):
    """:return: (container, reduced streams) or None on ffprobe failure"""
    try:
        raw = subprocess.run(
            ffprobe + ["-v", "error", "-print_format", "json", "-show_streams", path],
            capture_output=True, timeout=120, check=True, stdin=subprocess.DEVNULL,
        ).stdout
        streams = json.loads(raw).get("streams") or []
    except Exception as err:  # noqa: BLE001 - count + report, keep sweeping
        sys.stderr.write("skip %s: %s\n" % (os.path.basename(path)[:40], type(err).__name__))
        return None
    return os.path.splitext(path)[1][1:].lower(), [reduce_stream(s) for s in streams]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ffprobe", default="ffprobe", help="ffprobe command, may include wrapper")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--reduce", metavar="FILE", help="re-merge earlier output, no probing")
    opts = parser.parse_args()
    if opts.reduce:
        with open(opts.reduce) as handle:
            ordered = merge(json.load(handle))
        json.dump(ordered, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stderr.write("%d layouts, %d files\n" % (len(ordered), sum(l["count"] for l in ordered)))
        return
    ffprobe = shlex.split(opts.ffprobe)
    paths = [line.rstrip("\n") for line in sys.stdin if line.strip()]

    layouts = {}
    done = 0
    with ThreadPoolExecutor(opts.jobs) as pool:
        for result in pool.map(lambda p: probe(ffprobe, p), paths):
            done += 1
            if done % 250 == 0:
                sys.stderr.write("%d/%d files, %d layouts\n" % (done, len(paths), len(layouts)))
                sys.stderr.flush()
            if not result:
                continue
            container, streams = result
            key = json.dumps([container, streams], sort_keys=True)
            layouts.setdefault(key, {"count": 0, "container": container, "streams": streams})["count"] += 1
    ordered = merge(layouts.values())
    json.dump(ordered, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stderr.write("done: %d files, %d distinct layouts\n" % (done, len(ordered)))


if __name__ == "__main__":
    main()
