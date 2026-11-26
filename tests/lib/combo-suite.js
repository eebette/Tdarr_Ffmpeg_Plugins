"use strict";
// One test per plugin sequence, each run on every layout; summary table at the end.
const { describe, test, after } = require("node:test");
const fs = require("fs");
const path = require("path");
const { WORK } = require("./harness");
const { LAYOUTS, hasCover, runCase } = require("./combo");

const failSequence = (lines) => {
  const err = new Error(`\n  ${lines.join("\n  ")}`);
  err.stack = err.message;
  throw err;
};

/**
 * :param title: suite name
 * :param sequences: [[STEPS key]]
 * :param opts.matrix: print first-plugin x second-plugin table (pairs)
 */
const suite = (title, sequences, opts = {}) => {
  const layouts = Object.keys(LAYOUTS);
  const results = [];
  describe(title, () => {
    for (const seq of sequences) {
      test(seq.join(" > "), async () => {
        const lines = [];
        for (const layout of layouts) {
          // eslint-disable-next-line no-await-in-loop
          const r = await runCase(seq, layout);
          results.push({ seq, layout, cover: hasCover(layout), ...r });
          if (!r.ok) lines.push(`${layout}: ${r.failures.map((f) => `[${f.kind} @ ${f.at}] ${f.detail}`).join("\n      ")}`);
        }
        if (lines.length) failSequence(lines);
      });
    }

    after(() => {
      const out = [];
      const core = results.filter((r) => !r.cover);
      const cover = results.filter((r) => r.cover);
      const rate = (rs) => `${rs.filter((r) => r.ok).length}/${rs.length}`;
      const seqOk = (rs) => new Set(rs.filter((r) => !r.ok).map((r) => r.seq.join(">"))).size;
      out.push(`== ${title}: ${sequences.length} sequences x ${layouts.length} layouts`);
      out.push(`   layouts without cover art: ${rate(core)} cases pass, ${seqOk(core)} sequences have a failure`);
      out.push(`   layouts with cover art:    ${rate(cover)} cases pass`);
      const blame = new Map();
      core.forEach((r) => {
        const first = r.failures[0];
        if (!first) return;
        const key = `${first.kind} @ ${first.at}`;
        blame.set(key, (blame.get(key) || 0) + 1);
      });
      if (blame.size) {
        out.push("   first failure per case, no-cover layouts:");
        [...blame.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, n]) => out.push(`     ${String(n).padStart(4)}  ${k}`));
      }
      if (opts.matrix) {
        const keys = [...new Set(sequences.flat())];
        const bad = new Map();
        core.filter((r) => !r.ok).forEach((r) => bad.set(r.seq.join(">"), (bad.get(r.seq.join(">")) || 0) + 1));
        out.push("   pairs, rows = first plugin, columns = second; cell = failing no-cover layouts, . = clean");
        out.push(`   ${" ".repeat(14)}${keys.map((k) => k.slice(0, 5).padEnd(6)).join("")}`);
        keys.forEach((a) => out.push(`   ${a.padEnd(14)}${keys.map((b) => (a === b ? "-" : String(bad.get(`${a}>${b}`) || ".")).padEnd(6)).join("")}`));
      }
      process.stdout.write(`${out.join("\n")}\n`);
      try {
        fs.writeFileSync(path.join(WORK, `combo-${title.replace(/\W+/g, "-")}.json`), JSON.stringify(results));
      } catch (err) { /* report file is optional */ }
    });
  });
};

module.exports = { suite };
