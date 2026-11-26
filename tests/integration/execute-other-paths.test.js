"use strict";
// Execute paths the prod chains do not reach: MP4 output, second input file.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { fileObjFromFile, runChain, assertNoError, probe, scratch } = require("../lib/harness");
const { build } = require("../lib/media");

const START = { sourceRepo: "Community", pluginName: "ffmpegCommandStart" };
const EXECUTE = { sourceRepo: "Local", pluginName: "ffmpegCommandExecute" };
const brief = (file) => probe(file).streams.map((s) => `${s.codec_type[0]}:${s.codec_name}:${(s.tags || {}).language || ""}`);

test("MP4 target: text subtitles converted to mov_text, rest copied", async () => {
  const input = build({
    audio: [{ codec: "ac3", ch: 6, lang: "eng", default: true }, { codec: "aac", ch: 2, lang: "jpn" }],
    subs: [{ codec: "subrip", lang: "eng" }, { codec: "ass", lang: "jpn" }],
  }, "mp4");
  const result = await runChain([
    START,
    { sourceRepo: "Community", pluginName: "ffmpegCommandSetContainer", inputs: { container: "mp4", forceConform: "false" } },
    { sourceRepo: "Local", pluginName: "subtitleConvertToMovText" },
    EXECUTE,
  ], fileObjFromFile(input), { label: "mp4" });
  assertNoError(result);
  assert.match(result.outputFileObj._id, /\.mp4$/);
  assert.deepEqual(brief(result.outputFileObj._id), ["v:h264:und", "a:ac3:eng", "a:aac:jpn", "s:mov_text:eng", "s:mov_text:jpn"]);
});

test("stream from a second input file is mapped where its entry sits", async () => {
  const input = build({
    audio: [{ codec: "ac3", ch: 6, lang: "eng", default: true }],
    subs: [{ codec: "ass", lang: "jpn" }],
  }, "second-input");
  const srt = path.join(scratch("srt"), "extra.srt");
  fs.writeFileSync(srt, "1\n00:00:00,100 --> 00:00:00,900\nline\n");
  const fileObj = fileObjFromFile(input);
  const begun = await runChain([START], fileObj, { execute: "fake" });
  const command = begun.variables.ffmpegCommand;
  // Shape used by subtitleExtractToSrt / subtitleImportFromManifest: index = input number.
  command.additionalInputs = [srt];
  command.streams.splice(2, 0, {
    index: 1,
    codec_type: "subtitle",
    codec_name: "subrip",
    mapArgs: ["-map", "1:s:0?"],
    outputArgs: ["-c:s", "srt", "-metadata:s:s:{outputTypeIndex}", "language=eng"],
    inputArgs: [],
    removed: false,
  });
  command.shouldProcess = true;
  const result = await runChain([EXECUTE], fileObj, { variables: begun.variables, label: "second-input" });
  assertNoError(result);
  assert.deepEqual(brief(result.outputFileObj._id), ["v:h264:", "a:ac3:eng", "s:subrip:eng", "s:ass:jpn"]);
});
