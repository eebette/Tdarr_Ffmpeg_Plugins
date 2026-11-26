"use strict";
// Build tiny mkv from layout spec with tdarr-ffmpeg; describe files as token lists.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { FFMPEG, probe, scratch } = require("./harness");

const AUDIO_ENCODER = { dts: "dca" };
const EXPERIMENTAL = new Set(["truehd", "dts", "mlp"]);
const LAYOUT = { 1: "mono", 2: "stereo", 6: "5.1", 8: "7.1" };
const SRT = "1\n00:00:00,100 --> 00:00:00,900\nline\n";

/**
 * Build media file.
 *
 * Spec: {
 *   video: {codec: "h264"|"hevc"},                         default h264
 *   audio: [{codec, ch, lang, title, default, comment, id}],
 *   subs:  [{codec: "subrip"|"ass", lang, title, default, forced, id}],
 *   attachments: [{font: "a.ttf"} | {cover: "cover.png"}],  order kept
 * }
 * Every audio/sub stream gets TESTID tag (id, default a0/s0...): survives remux,
 * lets tests tell streams apart without touching title (plugins read titles).
 * Note: truehd/dts encoders cap at 5.1.
 *
 * :return: path to mkv
 */
const build = (spec, label = "media") => {
  const dir = scratch(label);
  const out = path.join(dir, "sample.mkv");
  const audio = spec.audio || [];
  const subs = spec.subs || [];
  const attachments = spec.attachments || [];
  const video = spec.video || {};
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=24:d=1"];

  audio.forEach((a) => {
    args.push("-f", "lavfi", "-t", "1", "-i", `anullsrc=channel_layout=${LAYOUT[a.ch || 2]}:sample_rate=48000`);
  });
  subs.forEach((s, i) => {
    const file = path.join(dir, `sub${i}.srt`);
    fs.writeFileSync(file, SRT);
    args.push("-i", file);
  });

  args.push("-map", "0:v:0", "-c:v:0", video.codec === "hevc" ? "libx265" : "libx264", "-pix_fmt", "yuv420p");
  if (video.title) args.push("-metadata:s:v:0", `title=${video.title}`);
  audio.forEach((a, i) => {
    args.push("-map", `${1 + i}:a:0`, `-c:a:${i}`, AUDIO_ENCODER[a.codec] || a.codec);
    args.push(`-metadata:s:a:${i}`, `language=${a.lang || "und"}`, `-metadata:s:a:${i}`, `TESTID=${a.id || `a${i}`}`);
    if (a.title) args.push(`-metadata:s:a:${i}`, `title=${a.title}`);
    const flags = [a.default ? "default" : null, a.comment ? "comment" : null].filter(Boolean).join("+");
    args.push(`-disposition:a:${i}`, flags || "0");
  });
  subs.forEach((s, i) => {
    args.push("-map", `${1 + audio.length + i}:s:0`, `-c:s:${i}`, s.codec || "subrip");
    args.push(`-metadata:s:s:${i}`, `language=${s.lang || "und"}`, `-metadata:s:s:${i}`, `TESTID=${s.id || `s${i}`}`);
    if (s.title) args.push(`-metadata:s:s:${i}`, `title=${s.title}`);
    const flags = [s.default ? "default" : null, s.forced ? "forced" : null].filter(Boolean).join("+");
    args.push(`-disposition:s:${i}`, flags || "0");
  });
  attachments.forEach((att, i) => {
    const name = att.font || att.cover;
    const file = path.join(dir, name);
    if (att.cover) {
      execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=32x48:d=1", "-frames:v", "1", file]);
    } else {
      fs.writeFileSync(file, `not a real font ${name}`);
    }
    args.push("-attach", file, `-metadata:s:t:${i}`, `mimetype=${att.cover ? "image/png" : "font/ttf"}`, `-metadata:s:t:${i}`, `filename=${name}`);
  });
  if (audio.some((a) => EXPERIMENTAL.has(a.codec))) args.push("-strict", "-2");
  args.push(out);
  execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "inherit"] });
  return out;
};

const tag = (stream, key) => {
  const tags = stream.tags || {};
  const hit = Object.keys(tags).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit ? tags[hit] : "";
};

/**
 * One token per stream, file order:
 *   v:<codec>                          video
 *   a:<codec>:<lang>:<ch>:<id>[*]      audio, * = default
 *   s:<codec>:<lang>:<id>[*][!]        subtitle, * = default, ! = forced
 *   t:<filename>                       attachment
 *   pic:<filename>:<codec>             attached picture (cover art)
 */
const describe = (file) => probe(file).streams.map((s) => {
  const d = s.disposition || {};
  if (s.codec_type === "video" && d.attached_pic === 1) return `pic:${tag(s, "filename")}:${s.codec_name}`;
  if (s.codec_type === "video") return `v:${s.codec_name}`;
  if (s.codec_type === "audio") return `a:${s.codec_name}:${tag(s, "language")}:${s.channels}:${tag(s, "TESTID")}${d.default ? "*" : ""}`;
  if (s.codec_type === "subtitle") return `s:${s.codec_name}:${tag(s, "language")}:${tag(s, "TESTID")}${d.default ? "*" : ""}${d.forced ? "!" : ""}`;
  if (s.codec_type === "attachment") return `t:${tag(s, "filename")}`;
  return `${s.codec_type}:${s.codec_name}`;
});

module.exports = { build, describe };
