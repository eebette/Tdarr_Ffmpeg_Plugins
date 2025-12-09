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
var details = function () { return ({
    name: "Deduplicate Subtitles",
    description: "Removes duplicate subtitle streams based on language, codec type, and title/handler_name. Prefers streams with default disposition, otherwise keeps first occurrence.",
    style: {
        borderColor: "teal",
    },
    tags: "subtitle",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: 6,
    icon: "faFilter",
    inputs: [],
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
var parseDispositionFromOutputArgs = function (outputArgs) {
    for (var i = 0; i < outputArgs.length - 1; i += 1) {
        if (/^-disposition:s/.test(outputArgs[i])) {
            var value = outputArgs[i + 1] || "";
            return {
                default: /default/.test(value),
                forced: /forced/.test(value),
            };
        }
    }
    return { default: null, forced: null };
};
var getDistinguishingName = function (stream, meta, format) {
    // First priority: use title if present
    var title = normalize(stream.title
        || (stream.tags && stream.tags.title)
        || (meta.tags && meta.tags.title)
        || "");
    if (title) {
        return title;
    }
    // Second priority: for mp4 containers, use handler_name
    var isMp4 = format && normalize(format).includes("mp4");
    if (isMp4) {
        var handlerName = normalize((stream.tags && stream.tags.handler_name)
            || (meta.tags && meta.tags.handler_name)
            || "");
        // Normalize mp4 handler names: treat empty/null/"SubtitleHandler" as equivalent
        if (handlerName === "" || handlerName === "null" || handlerName === "subtitlehandler") {
            return "";
        }
        return handlerName;
    }
    return "";
};
var plugin = function (args) {
    var lib = require("../../../../../methods/lib")();
    var inputs = lib.loadDefaultValues(normalizeInputs(args.inputs), details);
    args.inputs = inputs;
    flowUtils.checkFfmpegCommandInit(args);
    var streams = args.variables.ffmpegCommand.streams || [];
    var subtitleStreams = streams.filter(function (s) { return s.codec_type === "subtitle"; });
    if (subtitleStreams.length === 0) {
        args.jobLog("No subtitle streams to deduplicate.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    // Get metadata for all streams
    var metaByIndex = new Map();
    getStreams(args.inputFileObj).forEach(function (s) {
        metaByIndex.set(s.index, s);
    });
    // Detect container format
    var format = "";
    var ffprobe = args.inputFileObj.ffprobeData
        || args.inputFileObj.ffProbeData
        || (args.inputFileObj.meta && args.inputFileObj.meta.ffProbeData);
    if (ffprobe && ffprobe.format && ffprobe.format.format_name) {
        format = ffprobe.format.format_name;
    }
    // Group subtitle streams by unique key: language + codec + distinguishing_name
    var groups = new Map();
    subtitleStreams.forEach(function (stream) {
        var meta = metaByIndex.get(stream.index) || {};
        var lang = normalize(stream.language
            || (stream.tags && stream.tags.language)
            || (meta.tags && meta.tags.language)
            || "");
        var codec = normalize(meta.codec_name || stream.codec_name || "");
        var distinguishingName = getDistinguishingName(stream, meta, format);
        var key = [lang, codec, distinguishingName].join("|");
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        // Check if this stream is marked as default
        var dispositionFromArgs = parseDispositionFromOutputArgs(stream.outputArgs || []);
        var isDefault = dispositionFromArgs.default !== null
            ? dispositionFromArgs.default
            : (meta.disposition && meta.disposition.default === 1);
        groups.get(key).push({
            stream: stream,
            isDefault: isDefault,
            meta: meta,
            lang: lang,
            codec: codec,
            distinguishingName: distinguishingName,
        });
    });
    // For each group with duplicates, select which stream to keep
    var toKeep = new Set();
    groups.forEach(function (group, key) {
        if (group.length === 1) {
            // No duplicates for this key
            toKeep.add(group[0].stream.index);
            return;
        }
        // Multiple streams with same key - need to choose one
        var keeper = null;
        // Priority 1: Find one with default disposition
        for (var i = 0; i < group.length; i += 1) {
            if (group[i].isDefault) {
                keeper = group[i];
                break;
            }
        }
        // Priority 2: If no default found, keep the first in stream order
        if (!keeper) {
            keeper = group[0];
        }
        toKeep.add(keeper.stream.index);
        // Log the duplicates being removed
        group.forEach(function (item) {
            if (item.stream.index !== keeper.stream.index) {
                args.jobLog("Removing duplicate subtitle: lang=".concat(item.lang || "unknown", ", codec=").concat(item.codec || "unknown", ", name=").concat(item.distinguishingName || "none", " (index ").concat(item.stream.index, ")"));
            }
        });
    });
    // Process all streams: mark duplicates for removal, preserve others
    var changed = false;
    var processedStreams = streams.map(function (stream) {
        if (stream.codec_type !== "subtitle") {
            return stream;
        }
        if (!toKeep.has(stream.index)) {
            // This is a duplicate - mark for removal
            changed = true;
            return Object.assign({}, stream, { removed: true });
        }
        // Keep this stream - preserve sourceTypeIndex for correct mapping
        var meta = metaByIndex.get(stream.index) || {};
        var sourceTypeIndex = typeof stream.sourceTypeIndex === "number"
            ? stream.sourceTypeIndex
            : (typeof stream.typeIndex === "number" ? stream.typeIndex : meta.typeIndex);
        return Object.assign({}, stream, { sourceTypeIndex: sourceTypeIndex });
    });
    if (!changed) {
        args.jobLog("No duplicate subtitle streams found.");
        console.log("subtitleDeduplicate: no-change (no duplicates found)");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var kept = processedStreams.filter(function (s) { return !s.removed; });
    var overallOutputArgs = buildOverallOutputArgs(kept);
    console.log("subtitleDeduplicate: setting deduplicated streams", { streams: kept, overallOutputArgs: overallOutputArgs });
    args.variables.ffmpegCommand.streams = kept;
    args.variables.ffmpegCommand.overallOutputArguments = overallOutputArgs;
    args.variables.ffmpegCommand.shouldProcess = true;
    args.variables.ffmpegCommand.init = true;
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
