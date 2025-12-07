"use strict";
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
var normalizeList = function (value) {
    return normalize(value)
        .split(",")
        .map(function (part) { return part.trim(); })
        .filter(function (part) { return part.length > 0; });
};
var details = function () { return ({
    name: "Filter Subtitles by Language",
    description: "Keeps only subtitle streams whose language matches a provided comma-separated list.",
    style: {
        borderColor: "teal",
    },
    tags: "subtitle",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: 4,
    icon: "faLanguage",
    inputs: [
        {
            name: "Languages",
            type: "string",
            defaultValue: "eng",
            inputUI: "text",
            tooltip: "Comma-separated language tags to keep (e.g., 'eng,spa,jpn'). Empty keeps all.",
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
var plugin = function (args) {
    var lib = require("../../../../../methods/lib")();
    var inputs = lib.loadDefaultValues(normalizeInputs(args.inputs), details);
    args.inputs = inputs;
    flowUtils.checkFfmpegCommandInit(args);
    var languageInput = normalize(inputs.find(function (i) { return i.name === "Languages"; }).value || "");
    var languages = normalizeList(languageInput);
    var streams = args.variables.ffmpegCommand.streams || [];
    if (streams.length === 0) {
        args.jobLog("No mapped streams to filter.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    if (languages.length === 0) {
        args.jobLog("No language filter provided; keeping all subtitle streams.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    // Track whether anything changed so we can rebuild mapping when needed.
    var metaByIndex = new Map();
    getStreams(args.inputFileObj).forEach(function (s) {
        metaByIndex.set(s.index, s);
    });
    var extractLanguageFromOutputArgs = function (outputArgs) {
        for (var i = 0; i < outputArgs.length - 1; i += 1) {
            if (/^-metadata:s:s/.test(outputArgs[i]) && /^language=/.test(outputArgs[i + 1])) {
                return outputArgs[i + 1].split("=")[1];
            }
        }
        return "";
    };
    var changed = false;
    var filteredStreams = streams.map(function (stream) {
        if (stream.codec_type !== "subtitle") {
            return stream;
        }
        var meta = metaByIndex.get(stream.index) || {};
        var lang = normalize(stream.language
            || (meta.tags && meta.tags.language)
            || extractLanguageFromOutputArgs(stream.outputArgs || [])
            || "");
        var keep = languages.includes(lang);
        if (!keep) {
            changed = true;
            return Object.assign({}, stream, { removed: true });
        }
        // Preserve the original subtitle type index for correct -map after filtering.
        var sourceTypeIndex = typeof stream.sourceTypeIndex === "number"
            ? stream.sourceTypeIndex
            : (typeof stream.typeIndex === "number" ? stream.typeIndex : meta.typeIndex);
        return Object.assign({}, stream, { sourceTypeIndex: sourceTypeIndex });
    });
    if (changed) {
        var kept = filteredStreams.filter(function (s) { return !s.removed; });
        console.log("subtitleLanguageFilter: setting filtered streams", { streams: kept });
        args.variables.ffmpegCommand.streams = kept;
        // Clear cached output args so downstream rebuilds maps from the filtered set.
        args.variables.ffmpegCommand.overallOutputArguments = [];
        args.variables.ffmpegCommand.overallOuputArguments = [];
        args.variables.ffmpegCommand.shouldProcess = true;
        args.variables.ffmpegCommand.init = true;
    }
    else {
        console.log("subtitleLanguageFilter: no-change (no streams dropped)");
    }
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
