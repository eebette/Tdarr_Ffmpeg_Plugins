"use strict";
// Chain under test (from flow fixture): Begin Command -> Audio: Ensure EAC3 Fallback -> Execute.
// Contract: keep every input stream exactly once, same order; add one EAC3 before each
// TrueHD/DTS track lacking fallback; default flag moves from HD track to its new EAC3.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fileObjFromFile, runChain, assertNoError } = require("../lib/harness");
const { loadFlow, chainWith } = require("../lib/flow");
const { build, describe } = require("../lib/media");

const chain = chainWith(loadFlow("main-v2-movies"), "audioEAC3Fallback");

const run = async (name, spec) => {
  const input = build(spec, name);
  const result = await runChain(chain.steps, fileObjFromFile(input), { label: name });
  assertNoError(result);
  return { input, output: result.outputFileObj._id, before: describe(input), after: describe(result.outputFileObj._id), result };
};

test("TrueHD only: EAC3 added before it, takes default flag", async () => {
  const r = await run("truehd-only", { audio: [{ codec: "truehd", ch: 6, lang: "eng", default: true }] });
  assert.deepEqual(r.before, ["v:h264", "a:truehd:eng:6:a0*"]);
  assert.deepEqual(r.after, ["v:h264", "a:eac3:eng:6:a0*", "a:truehd:eng:6:a0"]);
});

test("TrueHD with AC3 fallback present: file untouched", async () => {
  const r = await run("has-fallback", {
    audio: [{ codec: "truehd", ch: 6, lang: "eng", default: true }, { codec: "ac3", ch: 6, lang: "eng" }],
  });
  assert.equal(r.output, r.input);
  assert.equal(r.result.commands.length, 0);
});

test("no HD audio: file untouched", async () => {
  const r = await run("no-hd", { audio: [{ codec: "aac", ch: 2, lang: "eng", default: true }] });
  assert.equal(r.output, r.input);
});

test("fallback in other language does not count", async () => {
  const r = await run("other-lang-fallback", {
    audio: [{ codec: "truehd", ch: 6, lang: "jpn", default: true }, { codec: "ac3", ch: 6, lang: "eng" }],
  });
  assert.deepEqual(r.after, ["v:h264", "a:eac3:jpn:6:a0*", "a:truehd:jpn:6:a0", "a:ac3:eng:6:a1"]);
});

test("several HD tracks, subtitles kept in order with flags", async () => {
  const r = await run("multi-hd-subs", {
    audio: [
      { codec: "truehd", ch: 6, lang: "jpn", default: true },
      { codec: "dts", ch: 6, lang: "eng" },
      { codec: "aac", ch: 2, lang: "eng", title: "Commentary", comment: true },
    ],
    subs: [
      { codec: "ass", lang: "eng", default: true },
      { codec: "subrip", lang: "eng", forced: true },
      { codec: "ass", lang: "jpn" },
    ],
  });
  assert.deepEqual(r.after, [
    "v:h264",
    "a:eac3:jpn:6:a0*", "a:truehd:jpn:6:a0",
    "a:eac3:eng:6:a1", "a:dts:eng:6:a1",
    "a:aac:eng:2:a2",
    "s:ass:eng:s0*", "s:subrip:eng:s1!", "s:ass:jpn:s2",
  ]);
});

test("font attachments kept", async () => {
  const r = await run("fonts", {
    audio: [{ codec: "truehd", ch: 6, lang: "jpn", default: true }],
    subs: [{ codec: "ass", lang: "eng" }],
    attachments: [{ font: "a.ttf" }, { font: "b.ttf" }],
  });
  assert.deepEqual(r.after, ["v:h264", "a:eac3:jpn:6:a0*", "a:truehd:jpn:6:a0", "s:ass:eng:s0", "t:a.ttf", "t:b.ttf"]);
});

test("cover art only: kept as png", async () => {
  const r = await run("cover-only", {
    audio: [{ codec: "truehd", ch: 6, lang: "jpn", default: true }],
    attachments: [{ cover: "cover.png" }],
  });
  assert.deepEqual(r.after, ["v:h264", "a:eac3:jpn:6:a0*", "a:truehd:jpn:6:a0", "pic:cover.png:png"]);
});

test("cover art before fonts: all kept", async () => {
  const r = await run("cover-then-fonts", {
    audio: [{ codec: "truehd", ch: 6, lang: "jpn", default: true }],
    attachments: [{ cover: "cover.png" }, { font: "a.ttf" }, { font: "b.ttf" }],
  });
  assert.deepEqual(r.after.slice().sort(), ["v:h264", "a:eac3:jpn:6:a0*", "a:truehd:jpn:6:a0", "pic:cover.png:png", "t:a.ttf", "t:b.ttf"].sort());
});

// Regression: 2026-11-24 prod failure. Fonts, cover.png, fonts in one file + EAC3 encode
// -> "Received a packet for an attachment stream", ffmpeg exit 234.
test("cover art between fonts: all kept", async () => {
  const r = await run("font-cover-font", {
    audio: [{ codec: "truehd", ch: 6, lang: "jpn", default: true }],
    subs: [{ codec: "ass", lang: "eng" }],
    attachments: [{ font: "a.ttf" }, { cover: "cover.png" }, { font: "b.ttf" }],
  });
  assert.deepEqual(r.after.slice().sort(), [
    "v:h264", "a:eac3:jpn:6:a0*", "a:truehd:jpn:6:a0", "s:ass:eng:s0", "pic:cover.png:png", "t:a.ttf", "t:b.ttf",
  ].sort());
});

// Default "Move to front": HD tracks (fallback before each) go ahead of all other audio.
// Intended where player cannot direct play HD tracks: first track must be playable.
test("HD Track Placement default: HD track with fallback moved ahead of lossy track", async () => {
  const r = await run("lossy-first", {
    audio: [{ codec: "ac3", ch: 2, lang: "jpn", default: true }, { codec: "truehd", ch: 6, lang: "eng" }],
  });
  assert.deepEqual(r.after, ["v:h264", "a:eac3:eng:6:a1", "a:truehd:eng:6:a1", "a:ac3:jpn:2:a0*"]);
});

test("HD Track Placement keep position: EAC3 inserted before HD track, nothing moved", async () => {
  const steps = chain.steps.map((s) => (s.pluginName === "audioEAC3Fallback" ? { ...s, inputs: { "HD Track Placement": "Keep position" } } : s));
  const input = build({
    audio: [{ codec: "ac3", ch: 2, lang: "jpn", default: true }, { codec: "truehd", ch: 6, lang: "eng" }, { codec: "aac", ch: 2, lang: "jpn" }],
  }, "lossy-first-keep");
  const result = await runChain(steps, fileObjFromFile(input), { label: "lossy-first-keep" });
  assertNoError(result);
  assert.deepEqual(describe(result.outputFileObj._id), ["v:h264", "a:ac3:jpn:2:a0*", "a:eac3:eng:6:a1", "a:truehd:eng:6:a1", "a:aac:jpn:2:a2"]);
});
