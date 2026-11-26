"use strict";
// Load plugins from assembled tree, build Tdarr-like args, run plugin chains.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TREE = process.env.TDARR_TREE;
const WORK = process.env.TDARR_WORK;
if (!TREE || !WORK) {
  throw new Error("TDARR_TREE/TDARR_WORK unset: run through tests/run.sh");
}
const FFMPEG = "tdarr-ffmpeg";
const FFPROBE = "ffprobe";
const REPO_DIR = { Local: "LocalFlowPlugins", Community: "CommunityFlowPlugins" };

let seq = 0;
const scratch = (label) => {
  seq += 1;
  const dir = path.join(WORK, "t", `${process.pid}-${seq}-${label.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const pluginPath = (sourceRepo, pluginName, version = "1.0.0") => {
  const root = path.join(TREE, "FlowPlugins", REPO_DIR[sourceRepo]);
  for (const category of fs.readdirSync(root)) {
    const file = path.join(root, category, pluginName, version, "index.js");
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`plugin not found: ${sourceRepo}/${pluginName}@${version}`);
};
// eslint-disable-next-line import/no-dynamic-require, global-require
const loadPlugin = (sourceRepo, pluginName, version) => require(pluginPath(sourceRepo, pluginName, version));

const probe = (file) => JSON.parse(execFileSync(
  FFPROBE,
  ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
));

// File object shaped like Tdarr's: plugins read _id, container, ffProbeData.
const fileObjFromProbe = (ffProbeData, id = "/media/sample.mkv") => ({
  _id: id,
  file: id,
  fileNameWithoutExtension: path.basename(id, path.extname(id)),
  container: path.extname(id).slice(1),
  fileMedium: "video",
  ffProbeData: JSON.parse(JSON.stringify(ffProbeData)),
  mediaInfo: {},
  meta: { Directory: path.dirname(id) },
});
const fileObjFromFile = (file) => fileObjFromProbe(probe(file), file);

// Stand-in ffmpeg for command-only runs: creates last arg (output), exit 0.
const fakeFfmpeg = () => {
  const file = path.join(WORK, "fake-ffmpeg.sh");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '#!/bin/sh\nfor a; do last="$a"; done\n: > "$last"\n', { mode: 0o755 });
  }
  return file;
};

/**
 * Run flow steps in order, like Tdarr following output 1.
 *
 * :param steps: [{sourceRepo, pluginName, version, inputs}] (from flow fixture or handmade)
 * :param fileObj: Tdarr-like file object
 * :param opts.execute: "real" runs tdarr-ffmpeg, "fake" records command only
 * :param opts.variables: start state (cloned), to resume from a captured step
 * :param opts.onStep: (step, variablesClone) after each plugin
 * :return: {variables, outputFileObj, commands: [argv per Execute], log, error, failedAt}
 */
const runChain = async (steps, fileObj, opts = {}) => {
  const mode = opts.execute || "real";
  const log = [];
  const commands = [];
  const workDir = scratch(opts.label || "chain");
  let variables = opts.variables ? JSON.parse(JSON.stringify(opts.variables)) : {
    ffmpegCommand: { init: false, inputFiles: [], streams: [], container: "", hardwareDecoding: false, shouldProcess: false, overallInputArguments: [], overallOuputArguments: [] },
    flowFailed: false,
    user: {},
  };
  let current = JSON.parse(JSON.stringify(fileObj));
  const original = JSON.parse(JSON.stringify(fileObj));

  for (const step of steps) {
    const mod = loadPlugin(step.sourceRepo, step.pluginName, step.version);
    const args = {
      inputFileObj: current,
      originalLibraryFile: original,
      librarySettings: { _id: "testlib", name: "Test Library" },
      inputs: JSON.parse(JSON.stringify(step.inputs || {})),
      variables,
      jobLog: (text) => {
        log.push(String(text));
        try {
          const parsed = JSON.parse(text);
          if (parsed && Array.isArray(parsed.spawnArgs)) commands.push(parsed.spawnArgs);
        } catch (err) { /* not JSON */ }
      },
      workDir,
      ffmpegPath: mode === "real" ? FFMPEG : fakeFfmpeg(),
      logFullCliOutput: false,
      updateWorker: () => {},
      logOutcome: () => {},
      deps: { fsextra: { ensureDirSync: (dir) => fs.mkdirSync(dir, { recursive: true }) } },
    };
    let result;
    // Plugins dump whole stream state to console: route into log, keep test output readable.
    const realLog = console.log;
    console.log = (...parts) => log.push(parts.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await mod.plugin(args);
    } catch (error) {
      return { variables, outputFileObj: current, commands, log, error, failedAt: step.pluginName };
    } finally {
      console.log = realLog;
    }
    variables = result.variables;
    if (opts.onStep) opts.onStep(step, JSON.parse(JSON.stringify(variables)));
    if (result.outputFileObj && result.outputFileObj._id !== current._id) {
      // Tdarr rescans new working file before next plugin.
      current = mode === "real"
        ? fileObjFromFile(result.outputFileObj._id)
        : { ...current, _id: result.outputFileObj._id };
    }
    if (result.outputNumber !== 1) {
      return { variables, outputFileObj: current, commands, log, error: null, stoppedAt: step.pluginName, outputNumber: result.outputNumber };
    }
  }
  return { variables, outputFileObj: current, commands, log, error: null };
};

// Fail with short ffmpeg error lines + command, not whole CLI dump.
const assertNoError = (result) => {
  if (!result.error) return;
  const lines = result.log.join("\n").split("\n")
    .filter((l) => /\b(error|invalid|failed|received a packet)\b/i.test(l) && !/^\s*at /.test(l))
    .map((l) => l.trim().slice(0, 200));
  const command = (result.commands[result.commands.length - 1] || []).join(" ");
  const err = new Error(`${result.failedAt} threw: ${result.error.message}\n  ${[...new Set(lines)].slice(0, 8).join("\n  ")}\n  command: ${command}`);
  err.stack = err.message;
  throw err;
};

module.exports = {
  assertNoError,
  FFMPEG, FFPROBE, WORK, scratch, loadPlugin, probe, fileObjFromProbe, fileObjFromFile, runChain,
};
