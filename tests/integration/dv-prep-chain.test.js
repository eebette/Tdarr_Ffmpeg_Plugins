"use strict";
// Chain under test (from flow fixture), run on Dolby Vision sources before MP4 build:
// Begin Command -> Remove Attachments -> Remove Attached Pictures -> Remove Data Streams
// -> Filter Audio (original,eng,jpn) -> Filter Subtitles (eng,jpn) -> Reorder Audio
// -> Reorder Subtitles -> Reorder Streams -> Stream Metadata Remove -> Execute.
// Expected lists below = behaviour observed 2026-11-25, read against plugin READMEs.
// Characterization: change them on purpose, never to make a red test green.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fileObjFromFile, runChain, assertNoError } = require("../lib/harness");
const { loadFlow, ffmpegChains } = require("../lib/flow");
const { build, describe } = require("../lib/media");
const { lint } = require("../lib/cmd");

const chain = ffmpegChains(loadFlow("main-v2-movies")).find((c) => c.steps.some((s) => s.pluginName === "audioReorder"));

const run = async (name, spec) => {
  const input = build(spec, name);
  const fileObj = fileObjFromFile(input);
  const result = await runChain(chain.steps, fileObj, { label: name });
  assertNoError(result);
  if (result.commands.length) assert.deepEqual(lint(result.commands[0], fileObj.ffProbeData.streams), []);
  return { input, output: result.outputFileObj._id, after: describe(result.outputFileObj._id), result };
};

test("languages filtered, tracks reordered, cover dropped", async () => {
  const r = await run("mixed", {
    video: { title: "Some Title" },
    audio: [
      { codec: "ac3", ch: 6, lang: "eng" },
      { codec: "truehd", ch: 6, lang: "jpn", default: true },
      { codec: "ac3", ch: 6, lang: "fra" },
      { codec: "aac", ch: 2, lang: "eng", title: "Commentary", comment: true },
      { codec: "eac3", ch: 6, lang: "jpn" },
    ],
    subs: [
      { codec: "ass", lang: "eng", default: true },
      { codec: "subrip", lang: "fra" },
      { codec: "subrip", lang: "jpn" },
      { codec: "subrip", lang: "eng", forced: true },
      { codec: "ass", lang: "jpn" },
    ],
    attachments: [{ font: "a.ttf" }, { cover: "cover.png" }, { font: "b.ttf" }],
  });
  assert.deepEqual(r.after, [
    "v:h264",
    // Reorder Audio default: codec order first (eac3,ac3,aac,truehd,dts), then language.
    // First track takes default flag; commentary last.
    "a:eac3:jpn:6:a4*", "a:ac3:eng:6:a0", "a:truehd:jpn:6:a1", "a:aac:eng:2:a3",
    // subtitle order: codec first (srt before ass), then language
    "s:subrip:eng:s3*!", "s:subrip:jpn:s2", "s:ass:eng:s0", "s:ass:jpn:s4",
    // "Remove Attachments" node matches codec_name against "attachment": fonts stay
    "t:a.ttf", "t:b.ttf",
  ]);
});

test("same codec: original language first, lossless after lossy", async () => {
  const r = await run("jpn-first", {
    audio: [{ codec: "truehd", ch: 6, lang: "jpn", default: true }, { codec: "ac3", ch: 6, lang: "eng" }, { codec: "ac3", ch: 6, lang: "jpn" }],
    subs: [{ codec: "ass", lang: "jpn", default: true }, { codec: "ass", lang: "eng" }],
  });
  assert.deepEqual(r.after, [
    "v:h264",
    "a:ac3:jpn:6:a2*", "a:ac3:eng:6:a1", "a:truehd:jpn:6:a0",
    "s:ass:jpn:s0*", "s:ass:eng:s1",
  ]);
});

// Known gap: Reorder Subtitles re-asserts "-disposition:s:0 default" on a track that is
// already default, so Execute remuxes a file that needs nothing. Costs time, not content.
// The community "Reorder Streams" node sits after Reorder Audio. Its default channel sort
// (7.1,5.1,2,1) would undo Reorder Audio's codec order, and blank "channels" falls back to
// that default (loadDefaultValues). Flows set processOrder "codecs,languages,streamTypes" on
// the node to drop the channel step. Pinned on a layout seen live: stereo AC3 goes ahead of
// 5.1 DTS (codec order) and takes default; node must not move 5.1 back to front.
test("Reorder Streams node: no channel sort, Reorder Audio's order survives", async () => {
  const r = await run("channels-vs-codec", {
    audio: [{ codec: "dts", ch: 6, lang: "eng", default: true }, { codec: "ac3", ch: 2, lang: "eng" }],
    subs: [{ codec: "subrip", lang: "eng", default: true }],
  });
  assert.deepEqual(r.after, ["v:h264", "a:ac3:eng:2:a1*", "a:dts:eng:6:a0", "s:subrip:eng:s0*"]);
});

test("nothing to change: file untouched", { todo: "subtitleReorder forces remux of clean file" }, async () => {
  const r = await run("already-clean", {
    audio: [{ codec: "eac3", ch: 6, lang: "eng", default: true }],
    subs: [{ codec: "subrip", lang: "eng", default: true }],
  });
  assert.equal(r.output, r.input);
});

test("only unwanted languages present: audio never emptied", async () => {
  const r = await run("foreign-only", {
    audio: [{ codec: "ac3", ch: 6, lang: "fra", default: true }, { codec: "ac3", ch: 6, lang: "deu" }],
    subs: [{ codec: "subrip", lang: "fra" }],
  });
  assert.ok(r.after.some((t) => t.startsWith("a:")), `no audio left: ${r.after}`);
});
