"use strict";
// Handmade ffprobe stream lists for unit tests: layout(V(), A("truehd", {...}), ...).
const disposition = (o) => ({
  default: o.default ? 1 : 0, forced: o.forced ? 1 : 0, comment: o.comment ? 1 : 0, attached_pic: o.pic ? 1 : 0,
});
const tags = (o) => {
  const t = {};
  if (o.lang) t.language = o.lang;
  if (o.title) t.title = o.title;
  if (o.filename) t.filename = o.filename;
  return t;
};
const LAYOUTS = { 1: "mono", 2: "stereo", 6: "5.1(side)", 8: "7.1" };

const V = (codec = "hevc", o = {}) => ({ codec_type: "video", codec_name: codec, width: 1920, height: 1080, disposition: disposition(o), tags: tags(o) });
const A = (codec, o = {}) => ({
  codec_type: "audio", codec_name: codec, channels: o.ch || 6, channel_layout: LAYOUTS[o.ch || 6], disposition: disposition(o), tags: tags(o),
});
const S = (codec, o = {}) => ({ codec_type: "subtitle", codec_name: codec, disposition: disposition(o), tags: tags(o) });
const FONT = (filename = "font.ttf") => ({ codec_type: "attachment", codec_name: "ttf", disposition: disposition({}), tags: { filename, mimetype: "font/ttf" } });
const COVER = (filename = "cover.png") => ({ codec_type: "video", codec_name: "png", codec_long_name: "PNG (Portable Network Graphics) image", disposition: disposition({ pic: true }), tags: { filename, mimetype: "image/png" } });
const DATA = () => ({ codec_type: "data", codec_name: "bin_data", disposition: disposition({}), tags: {} });

const layout = (...streams) => ({ streams: streams.map((s, index) => ({ index, ...s })) });

module.exports = { V, A, S, FONT, COVER, DATA, layout };
