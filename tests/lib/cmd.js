"use strict";
// Resolve ffmpeg argv against input ffprobe streams, the way ffmpeg would:
// which input stream lands at which output slot, with which codec. No media needed.
// Model checked against real ffmpeg in integration/cmd-model.test.js.

const NO_VALUE = new Set(["-y", "-n", "-dn", "-sn", "-an", "-vn", "-hide_banner", "-nostdin", "-shortest"]);

const kind = (stream) => {
  if (stream.codec_type === "video") return "v";
  if (stream.codec_type === "audio") return "a";
  if (stream.codec_type === "subtitle") return "s";
  if (stream.codec_type === "attachment") return "t";
  return "d";
};
const isPic = (stream) => Number((stream.disposition || {}).attached_pic) === 1;

// Stream specifier (after file index) -> matching streams. Forms: N, T, T:N.
const select = (streams, spec) => {
  if (spec === "") return streams.slice();
  if (/^\d+$/.test(spec)) return streams.filter((s) => s.pos === Number(spec));
  const m = /^([vVasdt])(?::(\d+))?$/.exec(spec);
  if (!m) throw new Error(`unsupported stream specifier: ${spec}`);
  // "v" = all video incl. attached pics; "V" = video without them; "t" = real attachments only.
  const pool = streams.filter((s) => (m[1] === "V" ? s.kind === "v" && !s.pic : s.kind === m[1]));
  return m[2] === undefined ? pool : pool.filter((_, i) => i === Number(m[2]));
};

/**
 * :param argv: ffmpeg args (single input file 0)
 * :param inputStreams: ffprobe streams of input
 * :return: {outputs: [{input, kind, pic, codec, disposition, inCodec}], errors: [string], file,
 *          attached: [file base name given to -attach]}
 *          codec = "copy" | encoder name | null (no -c matched: ffmpeg picks default encoder)
 */
const resolve = (argv, inputStreams) => {
  const inputs = inputStreams.map((s, pos) => ({
    pos, kind: kind(s), pic: isPic(s), inCodec: s.codec_name || "", stream: s,
  }));
  const errors = [];
  const mapped = [];
  const attached = []; // base names of files added with -attach (cover art re-attach)
  const options = []; // {name, spec, value} in argv order, output side only
  let seenInput = false;
  let file = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-") || /^-\d/.test(arg)) { file = arg; continue; }
    if (NO_VALUE.has(arg)) { options.push({ name: arg, spec: "", value: null }); continue; }
    const value = argv[i + 1];
    i += 1;
    if (arg === "-i") { if (seenInput) errors.push("more than one input: model covers single input"); seenInput = true; continue; }
    if (!seenInput) continue;
    if (arg === "-attach") { attached.push(String(value).split("/").pop()); continue; }
    if (arg === "-map") {
      const m = /^(-?)(\d+)(?::(.*?))?(\?)?$/.exec(value);
      if (!m || m[2] !== "0") { errors.push(`unsupported -map ${value}`); continue; }
      let hits;
      try { hits = select(inputs, m[3] === undefined ? "" : m[3]); } catch (err) { errors.push(`-map ${value}: ${err.message} (ffmpeg aborts)`); continue; }
      if (m[1] === "-") {
        hits.forEach((h) => { for (let k = mapped.length - 1; k >= 0; k -= 1) if (mapped[k].pos === h.pos) mapped.splice(k, 1); });
      } else if (hits.length === 0 && !m[4]) {
        errors.push(`-map ${value} matches no stream (ffmpeg aborts)`);
      } else {
        mapped.push(...hits);
      }
      continue;
    }
    const colon = arg.indexOf(":");
    options.push({ name: colon === -1 ? arg : arg.slice(0, colon), spec: colon === -1 ? "" : arg.slice(colon + 1), value });
  }

  const outputs = mapped.map((m, pos) => ({ pos, input: m.pos, kind: m.kind, pic: m.pic, inCodec: m.inCodec, codec: null, disposition: null }));
  options.forEach((opt) => {
    const target = (name) => {
      if (opt.name !== name) return [];
      try { return select(outputs, opt.spec); } catch (err) { errors.push(`${opt.name}:${opt.spec}: ${err.message}`); return []; }
    };
    [...target("-c"), ...target("-codec")].forEach((o) => { o.codec = opt.value; });
    target("-disposition").forEach((o) => { o.disposition = opt.value; });
    if ((opt.name === "-c" || opt.name === "-codec" || opt.name === "-disposition") && opt.spec !== "" && select(outputs, opt.spec).length === 0) {
      errors.push(`${opt.name}:${opt.spec} ${opt.value} matches no output stream`);
    }
  });
  // Real attachments carry no packets: ffmpeg copies them whatever -c says.
  outputs.forEach((o) => { if (o.kind === "t") o.codec = "copy"; });
  return { outputs, errors, file, attached };
};

/**
 * Problems a command would cause, from model alone.
 *
 * :return: [string], empty = clean
 */
const lint = (argv, inputStreams) => {
  const { outputs, errors, file } = resolve(argv, inputStreams);
  const problems = errors.slice();
  // ffmpeg cannot stream-copy cover art into mkv as attachment: it lands as plain
  // video track (attached_pic flag gone). Only -attach of extracted file keeps it.
  if (/\.mkv$/i.test(file || "") && outputs.some((o) => o.pic)) {
    problems.push("attached pic mapped into mkv: written as plain video track, no longer cover attachment");
  }
  outputs.forEach((o) => {
    if (o.codec === null) problems.push(`output #${o.pos} (input #${o.input}, ${o.pic ? "attached pic" : o.kind}): no codec option matches, ffmpeg re-encodes with default encoder`);
    else if (o.pic && o.codec !== "copy") problems.push(`output #${o.pos}: attached pic re-encoded with ${o.codec}`);
  });
  const copies = new Map();
  outputs.filter((o) => o.codec === "copy").forEach((o) => copies.set(o.input, (copies.get(o.input) || 0) + 1));
  copies.forEach((n, input) => { if (n > 1) problems.push(`input #${input} copied ${n} times`); });
  // ffmpeg 8.1 matroska muxer: encoder in play + real attachment mapped ahead of attached pic
  // -> "Received a packet for an attachment stream", exit 234. See integration regression test.
  const encoding = outputs.some((o) => o.codec !== "copy");
  const firstAttachment = outputs.findIndex((o) => o.kind === "t");
  const lastPic = outputs.map((o) => o.pic).lastIndexOf(true);
  if (encoding && firstAttachment !== -1 && lastPic > firstAttachment) {
    problems.push("attachment mapped before attached pic while encoding: ffmpeg mkv muxer fails (exit 234)");
  }
  return problems;
};

// Predicted output streams as type:codec, for model cross-check against real ffmpeg.
const predict = (argv, inputStreams) => resolve(argv, inputStreams).outputs.map((o) => {
  const codec = o.codec === "copy" ? o.inCodec : o.codec;
  if (o.kind === "t") return "t";
  return `${o.kind}:${codec}`; // attached pic comes out as plain video, see lint()
});

module.exports = { resolve, lint, predict };
