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
var getOutputStreamIndex = function (streams, stream) {
    var filtered = streams.filter(function (s) { return !s.removed; });
    var position = filtered.findIndex(function (s) { return s.index === stream.index; });
    return position === -1 ? 0 : position;
};
var getOutputStreamTypeIndex = function (streams, stream) {
    var filtered = streams.filter(function (s) { return !s.removed && s.codec_type === stream.codec_type; });
    var position = filtered.findIndex(function (s) { return s.index === stream.index; });
    return position === -1 ? 0 : position;
};
var codecTypeSelector = {
    video: "v",
    audio: "a",
    subtitle: "s",
    data: "d",
    attachment: "t",
};
var getCodecSelectorForStream = function (streams, stream) {
    var selector = codecTypeSelector[stream.codec_type] || stream.codec_type || "";
    if (!selector || selector.length !== 1) {
        var filtered = streams.filter(function (s) { return !s.removed; });
        var position = filtered.findIndex(function (s) { return s.index === stream.index; });
        return "-c:".concat(position === -1 ? 0 : position);
    }
    return "-c:".concat(selector, ":").concat(getOutputStreamTypeIndex(streams, stream));
};
var applyPlaceholders = function (args, streams, stream) {
    return args.map(function (arg) {
        var updated = arg;
        if (updated.includes("{outputIndex}")) {
            var filtered = streams.filter(function (s) { return !s.removed; });
            var position = filtered.findIndex(function (s) { return s.index === stream.index; });
            updated = updated.replace("{outputIndex}", String(position === -1 ? 0 : position));
        }
        if (updated.includes("{outputTypeIndex}")) {
            updated = updated.replace("{outputTypeIndex}", String(getOutputStreamTypeIndex(streams, stream)));
        }
        return updated;
    });
};
var normalizeCodecSelectors = function (outputArgs, streams, stream) {
    var codecSelector = getCodecSelectorForStream(streams, stream);
    return outputArgs.map(function (arg) {
        if (/^-c:[a-z]+$/.test(arg)) {
            return codecSelector;
        }
        if (/^-c:\d+$/.test(arg)) {
            return codecSelector;
        }
        if (/^-c:[a-z]+:\d+$/.test(arg)) {
            return codecSelector;
        }
        return arg;
    });
};
var normalizeMapArgs = function (mapArgs, streams, stream) {
    var selector = codecTypeSelector[stream.codec_type] || stream.codec_type || "";
    if (!selector) {
        return mapArgs;
    }
    var sourceTypeIndex = typeof stream.sourceTypeIndex === "number"
        ? stream.sourceTypeIndex
        : getOutputStreamTypeIndex(streams, stream);
    var mapTarget = "0:".concat(selector, ":").concat(sourceTypeIndex).concat(selector === "v" || selector === "t" ? "" : "?");
    return mapArgs.map(function (arg, idx) {
        var isMapValue = idx > 0 && mapArgs[idx - 1] === "-map";
        if (isMapValue && /^\d+:\d+$/.test(arg)) {
            return mapTarget;
        }
        return arg;
    });
};
var buildOverallOutputArgs = function (streams) {
    var activeStreams = (streams || []).filter(function (s) { return !s.removed; });
    return activeStreams.reduce(function (acc, stream) {
        var replacedArgs = applyPlaceholders(stream.outputArgs || [], activeStreams, stream);
        var mapArgs = normalizeMapArgs(stream.mapArgs || [], activeStreams, stream);
        var normalizedArgs = normalizeCodecSelectors(replacedArgs, activeStreams, stream);
        var hasCodecFlag = normalizedArgs.some(function (arg) { return /^-(?:c|codec)(?::[a-z]+(?::\\d+)?)?$/i.test(arg); });
        var outputArgsForStream = hasCodecFlag
            ? normalizedArgs
            : [getCodecSelectorForStream(activeStreams, stream), "copy"].concat(normalizedArgs);
        acc.push.apply(acc, mapArgs);
        acc.push.apply(acc, outputArgsForStream);
        return acc;
    }, []);
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
            || (stream.tags && stream.tags.language)
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
        var overallOutputArgs = buildOverallOutputArgs(kept);
        console.log("subtitleLanguageFilter: setting filtered streams", { streams: kept, overallOutputArgs: overallOutputArgs });
        args.variables.ffmpegCommand.streams = kept;
        args.variables.ffmpegCommand.overallOutputArguments = overallOutputArgs;
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
