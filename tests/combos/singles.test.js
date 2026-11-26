"use strict";
// Each plugin alone between Begin Command and Execute.
const { STEPS } = require("../lib/combo");
const { suite } = require("../lib/combo-suite");

suite("singles", Object.keys(STEPS).map((k) => [k]));
