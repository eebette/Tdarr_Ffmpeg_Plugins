"use strict";
var fs = require("fs");
var path = require("path");
var child_process_1 = require("child_process");
var flowUtils = require("../../../../FlowHelpers/1.0.0/interfaces/flowUtils");
var normalize = function (value) { return (value || "").toString().toLowerCase().trim(); };
var normalizeInputs = function (inputs) {
    if (Array.isArray(inputs)) {
        return inputs;
    }
    if (inputs && typeof inputs === "object") {
        return Object.keys(inputs).map(function (key) { return ({ name: key, value: inputs[key] }); });
    }
    return [];
};
var getInputValue = function (inputs, name, fallback) {
    var input = inputs.find(function (i) { return i.name === name; });
    if (!input || typeof input.value === "undefined") {
        return fallback;
    }
    return input.value;
};
var preferredTextCodecs = ["subrip", "ass", "ssa", "srt", "text", "mov_text", "webvtt"];
var tessMap = {
    eng: "eng", en: "eng",
    jpn: "jpn", ja: "jpn",
    fre: "fra", fr: "fra",
    spa: "spa", es: "spa",
    ger: "deu", de: "deu",
    ita: "ita", it: "ita",
    por: "por", pt: "por",
    chi: "chi_sim", zho: "chi_sim",
    kor: "kor", ko: "kor",
    und: "eng",
};
var commentaryRegex = /commentary|narration|descriptive|director|producer|writer/i;
var getStreams = function (fileObj) {
    var ffprobe = fileObj.ffprobeData
        || fileObj.ffProbeData
        || (fileObj.meta && fileObj.meta.ffProbeData)
        || { streams: [] };
    var typeCounters = {};
    return (ffprobe.streams || []).map(function (stream, idx) {
        var codecType = stream.codec_type || stream.type || "";
        var typeIndex = typeCounters[codecType] || 0;
        typeCounters[codecType] = typeIndex + 1;
        return Object.assign({}, stream, {
            index: typeof stream.index === "number" ? stream.index : idx,
            codec_type: codecType,
            typeIndex: typeIndex,
        });
    });
};
var isCommentary = function (stream) {
    var title = (stream.tags && (stream.tags.title || stream.tags.handler_name)) || "";
    return commentaryRegex.test(title);
};
var getMapArgsForMainSubtitle = function (stream) {
    var typeIndex = typeof stream.typeIndex === "number" ? stream.typeIndex : 0;
    return ["-map", "0:s:".concat(typeIndex, "?")];
};
var makeCopyOutputArgs = function (lang, title) {
    var outputArgs = [
        "-c:s",
        "copy",
        "-metadata:s:s:{outputTypeIndex}",
        "language=".concat(lang),
    ];
    if (title) {
        outputArgs.push("-metadata:s:s:{outputTypeIndex}");
        outputArgs.push("title=".concat(title));
    }
    return outputArgs;
};
var details = function () { return ({
    name: "Subtitles: Extract/OCR to SRT",
    description: "Extract one subtitle per language, OCR PGS to SRT, and embed as new text subtitles.",
    style: {
        borderColor: "teal",
    },
    tags: "subtitle",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: 5,
    icon: "faClosedCaptioning",
    inputs: [
        {
            name: "Dotnet Path",
            type: "string",
            defaultValue: "{{{args.variables.dotnetBin}}}",
            inputUI: "directory",
            tooltip: "Path to dotnet binary (from Install DV Tools).",
        },
        {
            name: "PgsToSrt Path",
            type: "string",
            defaultValue: "{{{args.variables.pgsToSrtDll}}}",
            inputUI: "directory",
            tooltip: "Path to PgsToSrt DLL/binary.",
        },
        {
            name: "Languages",
            type: "string",
            defaultValue: "",
            inputUI: "text",
            tooltip: "Optional comma-separated language filter (e.g., eng,spa). Empty keeps first per language.",
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: "Continue to next plugin",
        },
    ],
}); };
exports.details = details;
var pickLanguageSet = function (input) { return input.length === 0 ? null : new Set(input); };
var plugin = function (args) { return (function () {
    var lib = require("../../../../../methods/lib")();
    var inputs = lib.loadDefaultValues(normalizeInputs(args.inputs), details);
    args.inputs = inputs;
    flowUtils.checkFfmpegCommandInit(args);
    var dotnetPath = (getInputValue(inputs, "Dotnet Path", "") || "").toString().trim();
    var pgsToSrtPath = (getInputValue(inputs, "PgsToSrt Path", "") || "").toString().trim();
    if (!dotnetPath || !pgsToSrtPath) {
        args.jobLog("Missing dotnet or PgsToSrt paths; run Install DV Tools first.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var languageFilter = normalize(getInputValue(inputs, "Languages", "") || "");
    var languageSet = pickLanguageSet(languageFilter
        .split(",")
        .map(function (p) { return p.trim(); })
        .filter(function (p) { return p.length > 0; }));
    var allStreams = getStreams(args.inputFileObj);
    var subtitleStreams = allStreams.filter(function (s) { return s.codec_type === "subtitle"; });
    if (subtitleStreams.length === 0) {
        args.jobLog("No subtitle streams found; skipping.");
        console.log("subtitleExtractToSrt: no-change (no subtitle streams)");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var workDir = args.librarySettings.cache || "/tmp";
    var baseName = path.basename(args.inputFileObj._id || args.inputFileObj.file || "file", path.extname(args.inputFileObj._id || ""));
    var outDir = path.join(workDir, "srt_".concat(baseName));
    fs.mkdirSync(outDir, { recursive: true });
    var chosenByLang = new Map();
    subtitleStreams.forEach(function (s) {
        var lang = normalize((s.tags && s.tags.language) || "und");
        if (languageSet && !languageSet.has(lang)) {
            return;
        }
        if (!chosenByLang.has(lang)) {
            chosenByLang.set(lang, []);
        }
        chosenByLang.get(lang).push(s);
    });
    var additionalInputs = args.variables.ffmpegCommand.additionalInputs || [];
    var tempFiles = args.variables.ffmpegCommand.tempFiles || [];
    var newSubtitleStreams = [];
    var originalSubtitleStreams = [];
    var srtSeen = new Map(); // key: lang|type
    var startIndex = additionalInputs.length + 1; // main input is 0
    var inputIdx = startIndex;
    var ffmpegBin = args.ffmpegPath || "ffmpeg";
    chosenByLang.forEach(function (streamsForLang, lang) {
        streamsForLang.forEach(function (orig) {
            var mapArgs = getMapArgsForMainSubtitle(orig);
            var copyArgs = makeCopyOutputArgs(lang, (orig.tags && orig.tags.title) || "");
            originalSubtitleStreams.push({
                index: orig.index,
                codec_type: "subtitle",
                mapArgs: mapArgs,
                outputArgs: copyArgs,
                inputArgs: [],
                removed: false,
                language: lang,
            });
            var codecNorm = normalize(orig.codec_name || "");
            var typeKeyOrig = isCommentary(orig) ? "commentary" : (orig.disposition && orig.disposition.forced ? "forced" : "main");
            if (codecNorm === "subrip" || codecNorm === "srt") {
                srtSeen.set("".concat(lang, "|").concat(typeKeyOrig), true);
            }
        });
        var byType = new Map();
        streamsForLang.forEach(function (s) {
            var typeKey = isCommentary(s) ? "commentary" : (s.disposition && s.disposition.forced ? "forced" : "main");
            if (!byType.has(typeKey)) {
                byType.set(typeKey, []);
            }
            byType.get(typeKey).push(s);
        });
        byType.forEach(function (typeStreams, typeKey) {
            if (srtSeen.get("".concat(lang, "|").concat(typeKey))) {
                args.jobLog("Skipping new SRT for lang=".concat(lang, " type=").concat(typeKey, " (SRT already exists)."));
                console.log("subtitleExtractToSrt: skipping duplicate SRT creation", { lang: lang, type: typeKey });
                return;
            }
            var textStream = typeStreams.find(function (s) { return preferredTextCodecs.includes(normalize(s.codec_name)); });
            var target = textStream || typeStreams[0];
            var codec = normalize(target.codec_name || "");
            var outFile = path.join(outDir, "".concat(baseName, "_").concat(lang, "_").concat(typeKey, ".srt"));
            if (preferredTextCodecs.includes(codec)) {
                args.jobLog("Copying text subtitle to SRT for lang=".concat(lang, " type=").concat(typeKey));
                var cmdArgs = [
                    "-y",
                    "-i",
                    args.inputFileObj._id,
                    "-map",
                    "0:".concat(target.index),
                    "-c:s",
                    "srt",
                    outFile,
                ];
                (0, child_process_1.execFileSync)(ffmpegBin, cmdArgs, { stdio: "inherit" });
            }
            else {
                args.jobLog("OCR PGS to SRT for lang=".concat(lang, " type=").concat(typeKey, " (codec=").concat(codec, ")"));
                var trackNumber = (target.index || 0) + 1;
                var tLang = tessMap[lang] || "eng";
                var env = Object.assign({}, process.env, { TESSDATA_PREFIX: path.join(path.dirname(pgsToSrtPath), "tessdata") });
                var argsList = [
                    pgsToSrtPath,
                    "--input=".concat(args.inputFileObj._id),
                    "--output=".concat(outFile),
                    "--track=".concat(trackNumber),
                    "--tesseractlanguage=".concat(tLang),
                    "--tesseractversion=5",
                ];
                (0, child_process_1.execFileSync)(dotnetPath, argsList, { stdio: "inherit", env: env });
            }
            additionalInputs.push(outFile);
            tempFiles.push(outFile);
            var mapArgs = ["-map", "".concat(inputIdx, ":s:0?")];
            var outputArgs = [
                "-c:s",
                "srt",
                "-metadata:s:s:{outputTypeIndex}",
                "language=".concat(lang),
            ];
            var title = (target.tags && target.tags.title) || "";
            if (title) {
                outputArgs.push("-metadata:s:s:{outputTypeIndex}");
                outputArgs.push("title=".concat(title));
            }
            newSubtitleStreams.push({
                index: inputIdx,
                codec_type: "subtitle",
                mapArgs: mapArgs,
                outputArgs: outputArgs,
                inputArgs: [],
                removed: false,
                language: lang,
            });
            srtSeen.set("".concat(lang, "|").concat(typeKey), true);
            inputIdx += 1;
        });
    });
    if (newSubtitleStreams.length === 0) {
        args.jobLog("No subtitle streams converted to SRT; skipping extraction/OCR.");
        console.log("subtitleExtractToSrt: no-change (no new SRTs created)");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var combinedSubs = originalSubtitleStreams.concat(newSubtitleStreams);
    if (combinedSubs.length === 0) {
        args.jobLog("No subtitles were extracted or OCR'd.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var existingStreams = args.variables.ffmpegCommand.streams || [];
    var passthroughStreams = existingStreams.filter(function (s) { return s.codec_type !== "subtitle"; });
    args.variables.ffmpegCommand.streams = passthroughStreams.concat(combinedSubs);
    args.variables.ffmpegCommand.additionalInputs = additionalInputs;
    if (!tempFiles.includes(outDir)) {
        tempFiles.push(outDir);
    }
    args.variables.ffmpegCommand.tempFiles = tempFiles;
    args.variables.ffmpegCommand.shouldProcess = true;
    args.variables.ffmpegCommand.init = true;
    console.log("subtitleExtractToSrt: setting streams/inputs", {
        streams: args.variables.ffmpegCommand.streams,
        additionalInputs: args.variables.ffmpegCommand.additionalInputs,
    });
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
})(); };
exports.plugin = plugin;
