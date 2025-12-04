"use strict";
var fs = require("fs");
var path = require("path");
var flowUtils = require("../../../../FlowHelpers/1.0.0/interfaces/flowUtils");
var normalize = function (value) { return (value || "").toString().toLowerCase().trim(); };
var WORD_CORRECTIONS = {
    teh: "the",
    adn: "and",
    woud: "would",
    coud: "could",
    shoud: "should",
    becuase: "because",
    dont: "don't",
    wont: "won't",
    cant: "can't",
    alot: "a lot",
};
var GLOBAL_CHAR_FIXES = [
    { pattern: /[“”„»«]/g, replacement: '"' },
    { pattern: /[‘’]/g, replacement: "'" },
    { pattern: /…/g, replacement: "..." },
    { pattern: /[—–]/g, replacement: "-" },
];
var details = function () { return ({
    name: "Subtitles: Fix English OCR",
    description: "Cleans English SRT files generated earlier (typos, OCR artifacts) before muxing.",
    style: {
        borderColor: "teal",
    },
    tags: "subtitle",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: 6,
    icon: "faMagic",
    inputs: [],
    outputs: [
        {
            number: 1,
            tooltip: "Continue to next plugin",
        },
    ],
}); };
exports.details = details;
var cleanLine = function (line, stats) {
    var t = line;
    t = t.replace(/[\u200b\ufeff]/g, "");
    t = t.replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl");
    GLOBAL_CHAR_FIXES.forEach(function (_a) {
        var pattern = _a.pattern, replacement = _a.replacement;
        t = t.replace(pattern, replacement);
    });
    t = t.replace(/^(\s*-\s*)[l|1|](?=\s)/gm, function (_, dash) { return dash + "I"; });
    t = t.replace(/^(\s*-\s*)[l|1|](?=')/gm, function (_, dash) { return dash + "I"; });
    t = t.replace(/(\s)[l|1|](\s)/g, function (_, pre, post) { return pre + "I" + post; });
    t = t.replace(/(\s)[l|1|](?=')/g, function (_, pre) { return pre + "I"; });
    t = t.replace(/^(\s*)\|(?=\s)/gm, function (_, pre) { return pre + "I"; });
    t = t.replace(/(\s)\|(?=[A-Za-z])/g, function (_, pre) { return pre + "I"; });
    t = t.replace(/(?<=[A-Za-z])\|(?=[A-Za-z])/g, "I");
    t = t.replace(/(?<=[A-Za-z])0(?=[A-Za-z])/g, "o");
    t = t.replace(/(?<=[A-Za-z])5(?=[A-Za-z])/g, "s");
    t = t.replace(/(?<=[A-Za-z])1(?=[A-Za-z])/g, "l");
    t = t.replace(/(?<=[A-Za-z])8(?=[A-Za-z])/g, "B");
    t = t.replace(/q(?=[\s\.\,\!\?\;:'"\)\]]|$)/g, "g");
    t = t.replace(/\b[\w']+\b/g, function (word) {
        var lower = word.toLowerCase();
        var replacement = WORD_CORRECTIONS[lower];
        if (!replacement)
            return word;
        if (/^[A-Z]/.test(word)) {
            if (replacement.length === 0)
                return replacement;
            return replacement.charAt(0).toUpperCase() + replacement.slice(1);
        }
        return replacement;
    });
    t = t.replace(/\s+([\,\.\!\?\:\;])/g, "$1");
    t = t.replace(/([\,\.\!\?\:\;])([A-Za-z])/g, "$1 $2");
    return t;
};
var fixSrtFile = function (filePath) {
    var data = fs.readFileSync(filePath, "utf8");
    var lines = data.split(/\r?\n/);
    var cleaned = [];
    var buffer = [];
    var flush = function () {
        if (buffer.length > 0) {
            cleaned.push.apply(cleaned, buffer);
            buffer = [];
        }
    };
    for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        if (/^\d+$/.test(line)) {
            flush();
            buffer.push(line);
            continue;
        }
        if (line.includes("-->")) {
            buffer.push(line);
            continue;
        }
        buffer.push(cleanLine(line, {}));
        if (line.trim() === "" && buffer.length > 0) {
            flush();
        }
    }
    flush();
    fs.writeFileSync(filePath, cleaned.join("\n"), "utf8");
};
var plugin = function (args) {
    var lib = require("../../../../../methods/lib")();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    flowUtils.checkFfmpegCommandInit(args);
    var streams = args.variables.ffmpegCommand.streams || [];
    var additionalInputs = args.variables.ffmpegCommand.additionalInputs || [];
    if (streams.length === 0 || additionalInputs.length === 0) {
        args.jobLog("No subtitle inputs to fix.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    streams.forEach(function (stream) {
        if (stream.codec_type !== "subtitle") {
            return;
        }
        var lang = normalize(stream.language || "");
        if (lang !== "eng" && lang !== "en") {
            return;
        }
        var inputIdx = typeof stream.index === "number" ? stream.index : 1;
        var extraOffset = inputIdx - 1;
        if (extraOffset < 0 || extraOffset >= additionalInputs.length) {
            return;
        }
        var srtPath = additionalInputs[extraOffset];
        if (!fs.existsSync(srtPath)) {
            args.jobLog("Subtitle file missing for cleanup: ".concat(srtPath));
            return;
        }
        args.jobLog("Cleaning English subtitles: ".concat(path.basename(srtPath)));
        try {
            fixSrtFile(srtPath);
        }
        catch (err) {
            args.jobLog("Failed cleaning ".concat(srtPath, ": ").concat(err.message));
        }
    });
    args.variables.ffmpegCommand.shouldProcess = true;
    args.variables.ffmpegCommand.init = true;
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
