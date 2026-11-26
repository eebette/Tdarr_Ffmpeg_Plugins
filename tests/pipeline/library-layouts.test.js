"use strict";
// Sweep every distinct stream layout harvested from the real library
// (fixtures/probes/library-layouts.json.gz, see tools/harvest_probes.py) through the
// prod chains. No media: ffmpeg command is recorded, then judged by lib/cmd.js.
// Routing mirrors the flow: Dolby Vision sources -> DV-prep chain, the rest -> EAC3 chain.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { fileObjFromProbe, runChain } = require("../lib/harness");
const { loadFlow, ffmpegChains } = require("../lib/flow");
const { lint, resolve } = require("../lib/cmd");

const zlib = require("zlib");

const FILE = path.join(__dirname, "..", "fixtures", "probes", "library-layouts.json.gz");
const layouts = fs.existsSync(FILE) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString("utf8")) : [];
const chains = ffmpegChains(loadFlow("main-v2-movies"));
const EAC3 = chains.find((c) => c.steps.some((s) => s.pluginName === "audioEAC3Fallback"));
const DV_PREP = chains.find((c) => c.steps.some((s) => s.pluginName === "audioReorder"));

const isDolbyVision = (layout) => layout.streams.some((s) => s.codec_type === "video"
  && (s.side_data_list || []).some((d) => /dovi/i.test(d.side_data_type || "")));

// Collapse numbers so one defect on many layouts reads as one line.
const classOf = (problem) => problem.replace(/#?\d+/g, "N");

const sweep = async (chain, subset, extraChecks) => {
  const classes = new Map();
  const note = (problem, layout, index) => {
    const key = classOf(problem);
    const entry = classes.get(key) || { layouts: 0, files: 0, example: index, sample: problem };
    entry.layouts += 1;
    entry.files += layout.count;
    classes.set(key, entry);
  };
  for (const [index, layout] of subset) {
    const fileObj = fileObjFromProbe({ streams: layout.streams }, `/media/sample.${layout.container}`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runChain(chain.steps, fileObj, { execute: "fake", label: "sweep" });
    const problems = new Set();
    if (result.error) problems.add(`${result.failedAt} threw: ${result.error.message}`);
    for (const argv of result.commands) {
      lint(argv, layout.streams).forEach((p) => problems.add(p));
      const { outputs, attached } = resolve(argv, layout.streams);
      // cover art re-attached with -attach counts as kept
      const reattached = layout.streams.map((s, i) => ({ s, i }))
        .filter(({ s }) => Number((s.disposition || {}).attached_pic) === 1 && attached.includes((s.tags || {}).filename))
        .map(({ i }) => ({ input: i, kind: "v", pic: true, codec: "copy" }));
      extraChecks(outputs.concat(reattached), layout).forEach((p) => problems.add(p));
    }
    problems.forEach((p) => note(p, layout, index));
  }
  return [...classes.entries()].sort((a, b) => b[1].files - a[1].files);
};

const report = (classes, total) => classes
  .map(([key, e]) => `  ${e.files} files / ${e.layouts} layouts: ${key}\n      e.g. layout #${e.example}: ${e.sample}`)
  .join("\n") + `\n  (of ${total.files} files / ${total.layouts} layouts swept)`;

const totals = (subset) => ({ layouts: subset.length, files: subset.reduce((n, [, l]) => n + l.count, 0) });

test("library layouts present", { skip: layouts.length ? false : "no fixtures/probes/library-layouts.json.gz" }, () => {
  assert.ok(layouts.length > 0);
});

test("EAC3 chain: clean command for every non-DV layout", { skip: !layouts.length }, async () => {
  const subset = [...layouts.entries()].filter(([, l]) => !isDolbyVision(l));
  const classes = await sweep(EAC3, subset, (outputs, layout) => {
    // keep-everything chain: each input stream must come out at least once
    const kept = new Set(outputs.map((o) => o.input));
    const lost = layout.streams.map((_, i) => i).filter((i) => !kept.has(i));
    return lost.length ? [`input stream #${lost[0]} (${layout.streams[lost[0]].codec_type}) not mapped`] : [];
  });
  assert.equal(classes.length, 0, `\n${report(classes, totals(subset))}`);
});

test("DV-prep chain: clean command for every DV layout", { skip: !layouts.length }, async () => {
  const subset = [...layouts.entries()].filter(([, l]) => isDolbyVision(l));
  const classes = await sweep(DV_PREP, subset, (outputs, layout) => {
    const problems = [];
    if (!outputs.some((o) => o.kind === "v" && !o.pic)) problems.push("no video stream mapped");
    if (layout.streams.some((s) => s.codec_type === "audio") && !outputs.some((o) => o.kind === "a")) problems.push("all audio dropped");
    if (outputs.some((o) => o.codec !== "copy")) problems.push("stream re-encoded in copy-only chain");
    return problems;
  });
  assert.equal(classes.length, 0, `\n${report(classes, totals(subset))}`);
});
