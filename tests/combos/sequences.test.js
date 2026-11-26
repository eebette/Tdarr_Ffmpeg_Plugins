"use strict";
// Longer chains: the two prod chains, hand-picked sensible orders, seeded random orders.
const { sample } = require("../lib/combo");
const { suite } = require("../lib/combo-suite");

const PROD_DV_PREP = ["rmAttachments", "rmPics", "audioLang", "subLang", "audioOrder", "subOrder", "streamOrder", "metaRemove"];
const SENSIBLE = [
  ["eac3"],
  PROD_DV_PREP,
  // cleanup first, then fallback audio
  ["audioLang", "subLang", "eac3"],
  ["audioLang", "eac3", "audioOrder"],
  ["eac3", "audioLang", "audioOrder"],
  ["eac3", "audioOrder", "subOrder"],
  ["rmPics", "eac3"],
  ["rmAttachments", "eac3", "audioOrder"],
  // subtitle housekeeping
  ["subLang", "subDedupe", "subOrder"],
  ["subDedupe", "subLang", "subOrder"],
  ["subOrder", "subDedupe"],
  // order, then filter (filters must cope with moved streams)
  ["audioOrder", "audioLang"],
  ["subOrder", "subLang"],
  ["streamOrder", "audioLang", "subLang"],
  // metadata steps anywhere
  ["videoName", "metaRemove", "eac3"],
  ["eac3", "videoName", "metaRemove"],
  ["metaRemove", "audioLang", "subLang", "audioOrder", "subOrder"],
  // everything
  ["rmPics", "audioLang", "subLang", "subDedupe", "eac3", "audioOrder", "subOrder", "videoName", "metaRemove"],
];

suite("sequences-sensible", SENSIBLE);
suite("sequences-random", sample(40, 3, 7));
