"use strict";
// Plugin decisions on handmade layouts. No ffmpeg: command recorded, not run.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fileObjFromProbe, runChain, assertNoError } = require("../lib/harness");
const { V, A, S, FONT, layout } = require("../lib/probes");
const { resolve } = require("../lib/cmd");

const STEPS = [
  { sourceRepo: "Community", pluginName: "ffmpegCommandStart" },
  { sourceRepo: "Local", pluginName: "audioEAC3Fallback" },
  { sourceRepo: "Local", pluginName: "ffmpegCommandExecute" },
];

// :return: null when plugin leaves file alone, else audio outputs as "<input idx>:<codec>[:<bitrate>][*]" (* = default)
const audioPlan = async (probe) => {
  const result = await runChain(STEPS, fileObjFromProbe(probe), { execute: "fake" });
  assertNoError(result);
  if (result.commands.length === 0) return null;
  const argv = result.commands[0];
  return resolve(argv, probe.streams).outputs.filter((o) => o.kind === "a").map((o) => {
    const bitrate = o.codec === "copy" ? "" : `:${argv[argv.indexOf(`-b:${o.pos}`) + 1]}`;
    return `${o.input}:${o.codec}${bitrate}${o.disposition === "default" ? "*" : ""}`;
  });
};

test("no audio, no HD audio, or fallback present: nothing to do", async () => {
  assert.equal(await audioPlan(layout(V())), null);
  assert.equal(await audioPlan(layout(V(), A("eac3", { lang: "eng" }))), null);
  assert.equal(await audioPlan(layout(V(), A("truehd", { lang: "eng" }), A("ac3", { lang: "eng" }))), null);
  assert.equal(await audioPlan(layout(V(), A("dts", { lang: "eng" }), A("aac", { lang: "eng", ch: 2 }))), null);
});

test("bitrate follows channel count", async () => {
  assert.deepEqual(await audioPlan(layout(V(), A("truehd", { ch: 8, lang: "eng" }))), ["1:eac3:896k", "1:copy"]);
  assert.deepEqual(await audioPlan(layout(V(), A("truehd", { ch: 6, lang: "eng" }))), ["1:eac3:640k", "1:copy"]);
  assert.deepEqual(await audioPlan(layout(V(), A("dts", { ch: 2, lang: "eng" }))), ["1:eac3:320k", "1:copy"]);
  assert.deepEqual(await audioPlan(layout(V(), A("dts", { ch: 1, lang: "eng" }))), ["1:eac3:192k", "1:copy"]);
});

test("default flag moves to new EAC3 only when HD source was default", async () => {
  assert.deepEqual(
    await audioPlan(layout(V(), A("truehd", { lang: "jpn", default: true }), A("dts", { lang: "eng" }))),
    ["1:eac3:640k*", "2:eac3:640k", "1:copy", "2:copy"],
  );
});

test("commentary track is not a fallback", async () => {
  assert.deepEqual(
    await audioPlan(layout(V(), A("truehd", { lang: "eng" }), A("ac3", { lang: "eng", ch: 2, title: "Director Commentary" }))),
    ["1:eac3:640k", "1:copy", "2:copy"],
  );
});

test("fallback with more channels than HD track does not count", async () => {
  assert.deepEqual(
    await audioPlan(layout(V(), A("dts", { lang: "eng", ch: 2 }), A("ac3", { lang: "eng", ch: 6 }))),
    ["1:eac3:320k", "1:copy", "2:copy"],
  );
});

test("one fallback serves one HD track only", async () => {
  assert.deepEqual(
    await audioPlan(layout(V(), A("truehd", { lang: "eng" }), A("dts", { lang: "eng" }), A("ac3", { lang: "eng" }))),
    ["2:eac3:640k", "1:copy", "2:copy", "3:copy"],
  );
});

test("every non-audio stream mapped once, in input order", async () => {
  const probe = layout(V(), A("truehd", { lang: "eng" }), S("ass", { lang: "eng" }), S("subrip", { lang: "jpn" }), FONT("a.ttf"), FONT("b.ttf"));
  const result = await runChain(STEPS, fileObjFromProbe(probe), { execute: "fake" });
  assertNoError(result);
  const outputs = resolve(result.commands[0], probe.streams).outputs;
  assert.deepEqual(outputs.map((o) => `${o.input}:${o.codec}`), ["0:copy", "1:eac3", "1:copy", "2:copy", "3:copy", "4:copy", "5:copy"]);
});
