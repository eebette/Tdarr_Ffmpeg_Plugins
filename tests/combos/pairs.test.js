"use strict";
// Every ordered pair of plugins: does B still resolve streams after A changed them?
const { STEPS } = require("../lib/combo");
const { suite } = require("../lib/combo-suite");

const keys = Object.keys(STEPS);
suite("pairs", keys.flatMap((a) => keys.filter((b) => b !== a).map((b) => [a, b])), { matrix: true });
