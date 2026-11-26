"use strict";
// Read exported Tdarr flows (fixtures/flows) and pull out ffmpegCommand chains.
const fs = require("fs");
const path = require("path");

const FLOW_DIR = path.join(__dirname, "..", "fixtures", "flows");

const loadFlow = (name) => JSON.parse(fs.readFileSync(path.join(FLOW_DIR, `${name}.json`), "utf8"));
const flowNames = () => fs.readdirSync(FLOW_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

/**
 * Chains = Begin Command -> ... -> Execute, following output handle 1.
 *
 * :return: [{entry: "<node before Begin Command>:<handle>", steps: [{id, name, sourceRepo, pluginName, version, inputs}]}]
 */
const ffmpegChains = (flow) => {
  const byId = new Map(flow.flowPlugins.map((p) => [p.id, p]));
  const next = (id) => {
    const edge = flow.flowEdges.find((e) => e.source === id && String(e.sourceHandle) === "1");
    return edge ? edge.target : null;
  };
  return flow.flowPlugins
    .filter((p) => p.pluginName === "ffmpegCommandStart")
    .map((start) => {
      const steps = [];
      let id = start.id;
      const seen = new Set();
      while (id && !seen.has(id)) {
        seen.add(id);
        const p = byId.get(id);
        steps.push({
          id: p.id, name: p.name, sourceRepo: p.sourceRepo, pluginName: p.pluginName, version: p.version, inputs: p.inputsDB || {},
        });
        if (p.pluginName === "ffmpegCommandExecute") break;
        id = next(id);
      }
      if (steps[steps.length - 1].pluginName !== "ffmpegCommandExecute") {
        throw new Error(`chain from ${start.id} never reaches Execute`);
      }
      const entry = flow.flowEdges
        .filter((e) => e.target === start.id)
        .map((e) => `${byId.get(e.source).name}:${e.sourceHandle}`)
        .sort()
        .join(",");
      return { entry, steps };
    });
};

const shape = (chain) => chain.steps.map((s) => `${s.sourceRepo}/${s.pluginName}${JSON.stringify(s.inputs)}`);
const chainWith = (flow, pluginName) => {
  const hits = ffmpegChains(flow).filter((c) => c.steps.some((s) => s.pluginName === pluginName));
  if (hits.length === 0) throw new Error(`no chain with ${pluginName} in ${flow.name}`);
  // Several chains may hold plugin; must be identical to pick one silently.
  const first = JSON.stringify(shape(hits[0]));
  if (hits.some((c) => JSON.stringify(shape(c)) !== first)) {
    throw new Error(`chains with ${pluginName} in ${flow.name} differ; pick by entry`);
  }
  return hits[0];
};

module.exports = { loadFlow, flowNames, ffmpegChains, chainWith, shape };
