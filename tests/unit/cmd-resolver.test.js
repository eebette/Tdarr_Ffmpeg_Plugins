"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolve, lint, predict } = require("../lib/cmd");

const S = (codec_type, codec_name, extra = {}) => ({ codec_type, codec_name, disposition: { attached_pic: 0 }, ...extra });
const PIC = S("video", "png", { disposition: { attached_pic: 1 } });
const base = [S("video", "hevc"), S("audio", "truehd"), S("audio", "ac3"), S("subtitle", "ass")];
const withAtt = [...base, S("attachment", "ttf"), PIC, S("attachment", "ttf")];
const argv = (s) => ["-y", "-i", "in.mkv", ...s.split(" "), "out.mkv"];

test("type-indexed maps and codecs resolve per output type", () => {
  const cmd = argv("-map 0:v:0 -c:v:0 copy -map 0:a:0? -c:a:0 eac3 -map 0:a:0? -c:a:1 copy -map 0:a:1? -c:a:2 copy -map 0:s:0? -c:s:0 copy");
  assert.deepEqual(predict(cmd, base), ["v:hevc", "a:eac3", "a:truehd", "a:ac3", "s:ass"]);
  assert.deepEqual(lint(cmd, base), []);
});

test("optional map of missing stream is dropped, mandatory one is error", () => {
  assert.deepEqual(predict(argv("-map 0:v:0 -c copy -map 0:a:5?"), base), ["v:hevc"]);
  assert.match(lint(argv("-map 0:v:0 -c copy -map 0:a:5"), base).join(), /matches no stream/);
});

test("t selector skips attached pics; v selector includes them", () => {
  const out = resolve(argv("-map 0:t -map 0:v -c copy"), withAtt).outputs.map((o) => o.input);
  assert.deepEqual(out, [4, 6, 0, 5]);
});

test("attached pic with only -c:t option counts as re-encode", () => {
  const cmd = argv("-map 0:v:0 -c:v:0 copy -map 0:5 -c:t:0 copy");
  assert.match(lint(cmd, withAtt).join("\n"), /no codec option matches/);
  assert.match(lint(cmd, withAtt).join("\n"), /-c:t:0 copy matches no output stream/);
});

test("negative map removes stream", () => {
  assert.deepEqual(predict(argv("-map 0 -c copy -map -0:1 -map -0:t"), withAtt), ["v:hevc", "a:ac3", "s:ass", "v:png"]);
});

test("attachment before pic flagged only when encoding", () => {
  const maps = "-map 0:v:0 -map 0:a:0 -map 0:4 -map 0:5 -map 0:6";
  const muxer = (cmd) => lint(cmd, withAtt).filter((p) => /muxer fails/.test(p));
  assert.deepEqual(muxer(argv(`${maps} -c copy`)), []);
  assert.match(lint(argv(`${maps} -c copy -c:a:0 eac3`), withAtt).join(), /attachment mapped before attached pic/);
  assert.deepEqual(muxer(argv("-map 0:v:0 -map 0:a:0 -map 0:5 -map 0:4 -map 0:6 -c copy -c:a:0 eac3")), []);
});

test("any attached pic mapped into mkv is flagged", () => {
  assert.match(lint(argv("-map 0:v:0 -map 0:5 -c copy"), withAtt).join(), /plain video track/);
  assert.deepEqual(lint(argv("-map 0:v:0 -map 0:t -c copy"), withAtt), []);
});

test("later codec option wins", () => {
  assert.deepEqual(predict(argv("-map 0:a:0 -c:a eac3 -c:a:0 copy"), base), ["a:truehd"]);
});
