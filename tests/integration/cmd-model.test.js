"use strict";
// Keep lib/cmd.js honest: its prediction and its failure rule must match real tdarr-ffmpeg.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const { FFMPEG, probe, scratch } = require("../lib/harness");
const { build } = require("../lib/media");
const { lint, predict } = require("../lib/cmd");

const actual = (file) => probe(file).streams.map((s) => {
  if (s.codec_type === "attachment") return "t";
  return `${s.codec_type[0]}:${s.codec_name}`;
});

const SPEC = {
  audio: [{ codec: "truehd", ch: 6, lang: "jpn", default: true }, { codec: "ac3", ch: 2, lang: "eng" }],
  subs: [{ codec: "ass", lang: "eng" }, { codec: "subrip", lang: "jpn" }],
};
// input indexes: 0 v, 1 truehd, 2 ac3, 3 ass, 4 subrip, then attachments from 5
const ATTACH = {
  "font,cover,font": [{ font: "a.ttf" }, { cover: "cover.png" }, { font: "b.ttf" }],
  "cover,font,font": [{ cover: "cover.png" }, { font: "a.ttf" }, { font: "b.ttf" }],
  "font,font,cover": [{ font: "a.ttf" }, { font: "b.ttf" }, { cover: "cover.png" }],
};
const TAILS = {
  "all copy, input order": "-map 0:5 -map 0:6 -map 0:7 -c copy",
  "encode, input order": "-map 0:5 -map 0:6 -map 0:7 -c copy -c:a:0 eac3",
  "encode, reversed": "-map 0:7 -map 0:6 -map 0:5 -c copy -c:a:0 eac3",
  "encode, t selector then pics": "-map 0:t -c copy -c:a:0 eac3",
  "encode, dup audio, type-indexed codecs": "-map 0:a:0 -map 0:5 -map 0:6 -map 0:7 -c:v copy -c:s copy -c:a:0 eac3 -c:a:1 copy -c:a:2 copy",
};

for (const [layout, attachments] of Object.entries(ATTACH)) {
  for (const [name, tail] of Object.entries(TAILS)) {
    test(`${layout} | ${name}`, () => {
      const input = build({ ...SPEC, attachments }, `model-${layout}`);
      const streams = probe(input).streams;
      const out = path.join(scratch("model-out"), "out.mkv");
      const argv = ["-v", "error", "-y", "-i", input, ..."-map 0:v:0 -map 0:a:0 -map 0:a:1 -map 0:s:0 -map 0:s:1".split(" "), ...tail.split(" "), out];
      const run = spawnSync(FFMPEG, argv, { encoding: "utf8" });
      const problems = lint(argv, streams);
      if (run.status !== 0) {
        assert.notDeepEqual(problems, [], `ffmpeg failed but lint clean:\n${run.stderr.slice(0, 400)}`);
        return;
      }
      assert.deepEqual(problems.filter((p) => /muxer fails/.test(p)), [], "lint predicts muxer failure, ffmpeg succeeded");
      // mkv lists attachments last: compare tracks in order, attachments by count
      const sortT = (list) => [...list.filter((x) => x !== "t"), ...list.filter((x) => x === "t")];
      assert.deepEqual(actual(out), sortT(predict(argv, streams)));
      // ffmpeg success + cover mapped => cover must have lost attached_pic flag, as lint says
      const picKept = probe(out).streams.some((s) => s.disposition.attached_pic === 1);
      assert.equal(picKept, false, "cover survived as attachment: lint rule outdated");
    });
  }
}
