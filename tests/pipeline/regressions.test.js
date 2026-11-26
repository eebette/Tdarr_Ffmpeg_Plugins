"use strict";
// Named layouts that broke prod once. Command-level: fast, independent of library fixture.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fileObjFromProbe, runChain, assertNoError } = require("../lib/harness");
const { loadFlow, chainWith } = require("../lib/flow");
const { V, A, S, FONT, COVER, layout } = require("../lib/probes");
const { lint } = require("../lib/cmd");

const EAC3 = chainWith(loadFlow("main-v2-movies"), "audioEAC3Fallback");

const problems = async (chain, probe) => {
  const result = await runChain(chain.steps, fileObjFromProbe(probe), { execute: "fake" });
  assertNoError(result);
  return result.commands.flatMap((argv) => lint(argv, probe.streams));
};

// 2026-11-24: 4K anime remux, three TrueHD tracks (EAC3 encode needed), cover.png sitting
// between font attachments. ffmpeg exit 234 "Received a packet for an attachment stream".
test("EAC3 chain: cover art between fonts, HD audio without fallback", async () => {
  const probe = layout(
    V("hevc"),
    A("truehd", { ch: 8, lang: "jpn" }), A("truehd", { ch: 6, lang: "jpn" }), A("truehd", { ch: 6, lang: "eng" }),
    S("ass", { lang: "eng" }), S("subrip", { lang: "eng" }), S("ass", { lang: "eng" }), S("ass", { lang: "eng" }),
    S("subrip", { lang: "eng" }), S("subrip", { lang: "eng" }), S("ass", { lang: "jpn" }),
    FONT("a.ttf"), FONT("b.ttf"), FONT("c.ttf"), COVER(), FONT("d.ttf"), FONT("e.ttf"),
  );
  assert.deepEqual(await problems(EAC3, probe), []);
});

// PR #1: "-map 0:t:0" on a file whose only "attachment" is cover art -> ffmpeg exit 234.
test("EAC3 chain: cover art as only attachment", async () => {
  const probe = layout(V("hevc"), A("dts", { lang: "eng" }), COVER());
  assert.deepEqual(await problems(EAC3, probe), []);
});
