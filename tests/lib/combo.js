"use strict";
// Any-order robustness: run plugin sequences, check stream references at every step.
//
// Oracle needs no per-plugin expectations. Each ffmpegCommand stream entry carries the
// input stream it stands for (entry.index, set by Begin Command) plus its own args.
// "Intent" = surviving entries in order. After every plugin the command Execute would
// issue must resolve to exactly that intent (lib/cmd.js model), and at the end the file
// real ffmpeg writes must match it too. A separate frame check stops plugins from
// touching stream kinds they have no business with.
const { fileObjFromFile, runChain } = require("./harness");
const { build } = require("./media");
const { resolve } = require("./cmd");

const START = { sourceRepo: "Community", pluginName: "ffmpegCommandStart" };
const EXECUTE = { sourceRepo: "Local", pluginName: "ffmpegCommandExecute" };

// frame: what plugin may do, per stream kind (v a s t pic). Anything else = violation.
const local = (pluginName, inputs, frame) => ({ sourceRepo: "Local", pluginName, inputs, frame });
const community = (pluginName, inputs, frame) => ({ sourceRepo: "Community", pluginName, inputs, frame });
const ALL = ["v", "a", "s", "t", "pic"];
const STEPS = {
  // addMove: default "Move to front" puts HD tracks (each with its fallback) ahead of
  // other audio, by design. eac3Keep = "Keep position": pure insertion.
  eac3: local("audioEAC3Fallback", {}, { addMove: ["a"] }),
  eac3Keep: local("audioEAC3Fallback", { "HD Track Placement": "Keep position" }, { add: ["a"] }),
  audioLang: local("audioLanguageFilter", { Languages: "original,eng,jpn" }, { remove: ["a"] }),
  audioOrder: local("audioReorder", { "Language Order": "original,eng" }, { permute: ["a"] }),
  subLang: local("subtitleLanguageFilter", { Languages: "eng,jpn" }, { remove: ["s"] }),
  subOrder: local("subtitleReorder", { "Language Order": "original,eng,jpn", "Codec Order": "mov_text,srt,subrip,ass,ssa,pgs,hdmv_pgs_subtitle" }, { permute: ["s"] }),
  subDedupe: local("subtitleDeduplicate", {}, { remove: ["s"] }),
  metaRemove: local("streamMetadataRemove", { removeAudioMetadata: "false", removeSubtitleMetadata: "false" }, {}),
  videoName: local("videoCodecStandardize", { onlyUpdateExisting: "false" }, {}),
  streamOrder: community("ffmpegCommandRorderStreams", {}, { permute: ALL }),
  rmPics: community("ffmpegCommandRemoveStreamByProperty", { propertyToCheck: "disposition.attached_pic", valuesToRemove: "0", condition: "not_includes" }, { remove: ["pic"] }),
  rmAttachments: community("ffmpegCommandRemoveStreamByProperty", { propertyToCheck: "codec_type", valuesToRemove: "attachment", condition: "equals" }, { remove: ["t", "pic"] }),
  rmSubs: community("ffmpegCommandRemoveSubtitles", {}, { remove: ["s"] }),
};

// Sensible containers. Cover-art layouts kept apart: ffmpeg cannot copy mkv cover art as
// attachment, so they fail for a known, separate reason.
const LAYOUTS = {
  basic: { audio: [{ codec: "ac3", ch: 6, lang: "eng", default: true }], subs: [{ codec: "subrip", lang: "eng" }] },
  stereoOnly: { audio: [{ codec: "aac", ch: 2, lang: "eng", default: true }] },
  untagged: { audio: [{ codec: "ac3", ch: 6, lang: "und", default: true }], subs: [{ codec: "subrip", lang: "und" }] },
  hdOnly: { audio: [{ codec: "truehd", ch: 6, lang: "eng", default: true }, { codec: "dts", ch: 6, lang: "eng" }] },
  anime: {
    audio: [{ codec: "truehd", ch: 6, lang: "jpn", default: true }, { codec: "ac3", ch: 6, lang: "eng" }],
    subs: [
      { codec: "ass", lang: "eng", title: "Full Subtitles", default: true },
      { codec: "ass", lang: "eng", title: "Signs and Songs", forced: true },
      { codec: "subrip", lang: "jpn" },
    ],
    attachments: [{ font: "a.ttf" }, { font: "b.ttf" }],
  },
  foreignFirst: {
    audio: [{ codec: "eac3", ch: 6, lang: "jpn", default: true }, { codec: "eac3", ch: 6, lang: "eng" }],
    subs: [{ codec: "ass", lang: "jpn" }, { codec: "ass", lang: "eng", default: true }],
  },
  multiLang: {
    video: { title: "Feature" },
    audio: [
      { codec: "dts", ch: 6, lang: "eng", default: true },
      { codec: "ac3", ch: 6, lang: "fra" },
      { codec: "ac3", ch: 6, lang: "spa" },
      { codec: "ac3", ch: 6, lang: "jpn" },
      { codec: "aac", ch: 2, lang: "eng", title: "Director Commentary", comment: true },
    ],
    subs: [
      { codec: "subrip", lang: "eng", forced: true },
      { codec: "subrip", lang: "eng" },
      { codec: "subrip", lang: "eng", title: "SDH" },
      { codec: "subrip", lang: "fra" },
      { codec: "ass", lang: "jpn" },
      { codec: "subrip", lang: "spa" },
    ],
  },
  dupSubs: {
    audio: [{ codec: "truehd", ch: 6, lang: "eng", default: true }, { codec: "ac3", ch: 6, lang: "eng" }],
    subs: [
      { codec: "subrip", lang: "eng", title: "English" },
      { codec: "subrip", lang: "eng", title: "English" },
      { codec: "ass", lang: "eng", title: "English", default: true },
      { codec: "subrip", lang: "jpn" },
      { codec: "subrip", lang: "jpn" },
    ],
  },
  coverOnly: { audio: [{ codec: "dts", ch: 6, lang: "eng", default: true }], subs: [{ codec: "subrip", lang: "eng" }], attachments: [{ cover: "cover.png" }] },
  coverFirst: {
    audio: [{ codec: "ac3", ch: 6, lang: "jpn", default: true }, { codec: "ac3", ch: 6, lang: "eng" }],
    subs: [{ codec: "ass", lang: "eng" }],
    attachments: [{ cover: "cover.png" }, { font: "a.ttf" }, { font: "b.ttf" }],
  },
  coverMid: {
    audio: [{ codec: "truehd", ch: 6, lang: "jpn", default: true }],
    subs: [{ codec: "ass", lang: "eng" }, { codec: "subrip", lang: "jpn" }],
    attachments: [{ font: "a.ttf" }, { cover: "cover.png" }, { font: "b.ttf" }],
  },
};
const hasCover = (name) => (LAYOUTS[name].attachments || []).some((a) => a.cover);

const ENCODER_CODEC = { libx264: "h264", libx265: "hevc", srt: "subrip", dca: "dts" };
const tagOf = (stream, key) => {
  const tags = stream.tags || {};
  const hit = Object.keys(tags).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit ? String(tags[hit]) : "";
};
const kindOf = (stream) => {
  const d = stream.disposition || {};
  if (stream.codec_type === "video") return Number(d.attached_pic) === 1 ? "pic" : "v";
  return { audio: "a", subtitle: "s", attachment: "t" }[stream.codec_type] || "d";
};
// Stream as tests see it: kind, stable id, codec, default/forced.
const view = (stream) => {
  const kind = kindOf(stream);
  const d = stream.disposition || {};
  return {
    kind,
    id: tagOf(stream, "TESTID") || tagOf(stream, "filename") || kind,
    codec: stream.codec_name || "",
    isDefault: Number(d.default) === 1,
    forced: Number(d.forced) === 1,
  };
};
const flagged = (kind) => kind === "a" || kind === "s";
const token = (v) => `${v.kind}:${v.id}:${v.codec}${flagged(v.kind) && v.isDefault ? "*" : ""}${flagged(v.kind) && v.forced ? "!" : ""}`;
const withDisposition = (v, value) => (value === null || value === undefined ? v : {
  ...v, isDefault: /default/.test(value), forced: /forced/.test(value),
});
const argAfter = (args, pattern) => {
  let value = null;
  (args || []).forEach((arg, i) => { if (pattern.test(arg)) value = args[i + 1]; });
  return value;
};
const withCodec = (v, codec) => (!codec || codec === "copy" ? v : { ...v, codec: ENCODER_CODEC[codec] || codec });

/**
 * What plugin state says should come out, in order.
 *
 * :param state: variables.ffmpegCommand
 * :param inputStreams: ffprobe streams of source file
 * :return: [view]
 */
const intent = (state, inputStreams) => (state.streams || []).filter((e) => !e.removed).map((entry) => {
  let source = typeof entry.index === "number" ? inputStreams[entry.index] : null;
  if (!source) {
    // Stream made by a plugin (e.g. new EAC3): source = what its own map points at.
    const hit = resolve(["-i", "x", ...(entry.mapArgs || []), "x.mkv"], inputStreams).outputs[0];
    source = hit ? inputStreams[hit.input] : { codec_type: entry.codec_type, codec_name: entry.codec_name };
  }
  const base = withCodec(view(source), argAfter(entry.outputArgs, /^-(c|codec)(:|$)/));
  return withDisposition(base, argAfter(entry.outputArgs, /^-disposition(:|$)/));
});

// What a command would produce, per lib/cmd.js. "-attach <file>" = cover art put back
// as attachment: counts as the input pic carrying that file name.
const predicted = (argv, inputStreams) => {
  const { outputs, attached } = resolve(argv, inputStreams);
  const mapped = outputs.map((o) => withDisposition(
    withCodec(view(inputStreams[o.input]), o.codec === null ? "DEFAULT-ENCODER" : o.codec),
    o.disposition,
  ));
  const pics = inputStreams.map(view).filter((v) => v.kind === "pic");
  return mapped.concat(attached.map((name) => pics.find((v) => v.id === name) || { kind: "pic", id: name, codec: "?" }));
};

// ffmpeg's own rule (set_dispositions): no -disposition option anywhere + 2 or more streams
// of a type + none default => first one becomes default. Not plugin drift; applied to both
// sides of every comparison, and proven by the real-output check.
const settle = (views, argv) => {
  if (!argv || argv.some((a) => /^-disposition(:|$)/.test(a))) return views;
  const out = views.map((v) => ({ ...v }));
  ["a", "s"].forEach((kind) => {
    const same = out.filter((v) => v.kind === kind);
    if (same.length >= 2 && !same.some((v) => v.isDefault)) same[0].isDefault = true;
  });
  return out;
};

// Tracks compared in order; attachments + cover as a set (mkv lists them after tracks).
const split = (views) => ({
  tracks: views.filter((v) => "vas".includes(v.kind)).map(token),
  extras: views.filter((v) => !"vas".includes(v.kind)).map(token).sort(),
});
const diff = (want, got) => {
  const a = split(want);
  const b = split(got);
  if (a.tracks.join(" ") !== b.tracks.join(" ")) return `tracks: want [${a.tracks.join(" ")}] got [${b.tracks.join(" ")}]`;
  if (a.extras.join(" ") !== b.extras.join(" ")) return `attachments: want [${a.extras.join(" ")}] got [${b.extras.join(" ")}]`;
  return null;
};

const isSubsequence = (small, big) => { let i = 0; big.forEach((x) => { if (x === small[i]) i += 1; }); return i === small.length; };
const frameViolations = (stepKey, before, after) => {
  const frame = STEPS[stepKey].frame;
  const out = [];
  for (const kind of ALL) {
    const prev = before.filter((v) => v.kind === kind).map((v) => `${v.id}:${v.codec}`);
    const cur = after.filter((v) => v.kind === kind).map((v) => `${v.id}:${v.codec}`);
    if (prev.join(" ") === cur.join(" ")) continue;
    const ok = ((frame.remove || []).includes(kind) && isSubsequence(cur, prev))
      || ((frame.add || []).includes(kind) && isSubsequence(prev, cur))
      || ((frame.permute || []).includes(kind) && prev.slice().sort().join(" ") === cur.slice().sort().join(" "))
      || ((frame.addMove || []).includes(kind) && isSubsequence(prev.slice().sort(), cur.slice().sort()));
    if (!ok) out.push(`${stepKey} changed ${kind} streams: [${prev.join(" ")}] -> [${cur.join(" ")}]`);
  }
  return out;
};

const media = new Map();
const mediaFor = (layoutName) => {
  if (!media.has(layoutName)) media.set(layoutName, fileObjFromFile(build(LAYOUTS[layoutName], `combo-${layoutName}`)));
  return media.get(layoutName);
};

/**
 * Run one sequence on one layout.
 *
 * :param keys: STEPS keys in order
 * :return: {ok, failures: [{kind, at, detail}]}
 *          kind: threw | frame | reference (command != intent after a plugin)
 *                | ffmpeg (real run failed) | output (real file != intent)
 */
const runCase = async (keys, layoutName) => {
  const fileObj = mediaFor(layoutName);
  const input = fileObj.ffProbeData.streams;
  const failures = [];
  const states = [];
  const steps = [START, ...keys.map((k) => ({ ...STEPS[k], key: k }))];
  const built = await runChain(steps, fileObj, { execute: "fake", onStep: (step, variables) => states.push({ key: step.key, variables }) });
  if (built.error) return { ok: false, failures: [{ kind: "threw", at: built.failedAt, detail: built.error.message.slice(0, 160) }] };

  let previous = input.map(view);
  for (const { key, variables } of states) {
    const want = intent(variables.ffmpegCommand, input);
    if (key) {
      frameViolations(key, previous, want).forEach((detail) => failures.push({ kind: "frame", at: key, detail }));
      // Command Execute would issue right here, after this plugin.
      // eslint-disable-next-line no-await-in-loop
      const dry = await runChain([EXECUTE], fileObj, { execute: "fake", variables });
      if (dry.error) failures.push({ kind: "threw", at: `Execute after ${key}`, detail: dry.error.message.slice(0, 160) });
      else {
        const argv = dry.commands[0] || null;
        const got = argv ? predicted(argv, input) : input.map(view);
        const delta = diff(settle(want, argv), settle(got, argv));
        if (delta) failures.push({ kind: "reference", at: key, detail: `${dry.commands.length ? "" : "(Execute skipped) "}${delta}` });
      }
    }
    previous = want;
  }

  const finalState = states[states.length - 1].variables;
  const real = await runChain([EXECUTE], fileObj, { execute: "real", variables: finalState, label: `combo-${layoutName}` });
  if (real.error) {
    const line = real.log.join("\n").split("\n").find((l) => /Received a packet|Invalid argument|matches no streams|Error (opening|while)|Unable to/i.test(l)) || real.error.message;
    failures.push({ kind: "ffmpeg", at: "Execute", detail: line.trim().replace(/0x[0-9a-f]+/g, "").slice(0, 160) });
  } else {
    const want = settle(intent(finalState.ffmpegCommand, input), real.commands[0] || null);
    const delta = diff(want, real.outputFileObj.ffProbeData.streams.map(view));
    if (delta) failures.push({ kind: "output", at: "Execute", detail: delta });
  }
  return { ok: failures.length === 0, failures };
};

// Deterministic shuffles: same sequences every run.
const rng = (seed) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; };
const sample = (count, minLen, maxLen, seed = 20261125) => {
  const next = rng(seed);
  const keys = Object.keys(STEPS);
  const seen = new Set();
  const out = [];
  while (out.length < count) {
    const pool = keys.slice();
    const len = minLen + Math.floor(next() * (maxLen - minLen + 1));
    const seq = [];
    while (seq.length < len) seq.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
    if (!seen.has(seq.join(">"))) { seen.add(seq.join(">")); out.push(seq); }
  }
  return out;
};

module.exports = { STEPS, LAYOUTS, hasCover, runCase, sample, intent, predicted, view, token };
