"use strict";
// Flow fixtures = exported prod flows. Guard: chains are what tests assume, every plugin loads.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("../lib/harness");
const { loadFlow, flowNames, ffmpegChains, shape } = require("../lib/flow");

const EAC3 = ["ffmpegCommandStart", "audioEAC3Fallback", "ffmpegCommandExecute"];
const DV_PREP = [
  "ffmpegCommandStart",
  "ffmpegCommandRemoveStreamByProperty",
  "ffmpegCommandRemoveStreamByProperty",
  "ffmpegCommandRemoveDataStreams",
  "audioLanguageFilter",
  "subtitleLanguageFilter",
  "audioReorder",
  "subtitleReorder",
  "ffmpegCommandRorderStreams",
  "streamMetadataRemove",
  "ffmpegCommandExecute",
];

for (const name of flowNames()) {
  test(`${name}: ffmpegCommand chains as expected`, () => {
    const chains = ffmpegChains(loadFlow(name)).map((c) => c.steps.map((s) => s.pluginName));
    assert.deepEqual(chains.sort(), [DV_PREP, DV_PREP, EAC3].sort());
  });

  test(`${name}: every chain plugin loads from tree`, () => {
    for (const chain of ffmpegChains(loadFlow(name))) {
      for (const step of chain.steps) {
        const mod = loadPlugin(step.sourceRepo, step.pluginName, step.version);
        assert.equal(typeof mod.plugin, "function", step.pluginName);
        assert.equal(typeof mod.details, "function", step.pluginName);
      }
    }
  });
}

test("movies and series flows: same chains, same inputs", () => {
  const all = flowNames().map((n) => ffmpegChains(loadFlow(n)).map(shape).sort());
  all.slice(1).forEach((chains) => assert.deepEqual(chains, all[0]));
});
