"use strict";
var flowUtils = require("../../../../FlowHelpers/1.0.0/interfaces/flowUtils");
var codecTypeSelector = {
    video: "v",
    audio: "a",
    subtitle: "s",
    data: "d",
    attachment: "t",
};
var normalize = function (value) { return (value || "").toString().toLowerCase(); };
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
    name: "Stream Metadata: Remove Handler/Title",
    description: "Removes handler_name and title metadata from video and/or audio streams.",
    style: {
        borderColor: "orange",
    },
    tags: "video,audio",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: 3,
    icon: "faEraser",
    inputs: [
        {
            label: "Remove video stream metadata",
            name: "removeVideoMetadata",
            type: "boolean",
            defaultValue: "true",
            inputUI: {
                type: "switch",
            },
            tooltip: "Remove title and handler_name from video streams.",
        },
        {
            label: "Remove audio stream metadata",
            name: "removeAudioMetadata",
            type: "boolean",
            defaultValue: "false",
            inputUI: {
                type: "switch",
            },
            tooltip: "Remove title and handler_name from audio streams.",
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
var getOutputStreamTypeIndex = function (streams, stream) {
    var filtered = streams.filter(function (s) { return !s.removed && s.codec_type === stream.codec_type; });
    var position = filtered.findIndex(function (s) { return s.index === stream.index; });
    return position === -1 ? 0 : position;
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
        var hasCodecFlag = normalizedArgs.some(function (arg) { return /^-(?:c|codec)(?::[a-z]+(?::\d+)?)?$/i.test(arg); });
        var outputArgsForStream = hasCodecFlag
            ? normalizedArgs
            : [getCodecSelectorForStream(activeStreams, stream), "copy"].concat(normalizedArgs);
        acc.push.apply(acc, mapArgs);
        acc.push.apply(acc, outputArgsForStream);
        return acc;
    }, []);
};
var removeMetadataArgs = function (outputArgs, streamType, container) {
    var isMkv = normalize(container) === "mkv";
    var metadataKey = isMkv ? "title" : "handler_name";
    var selector = codecTypeSelector[streamType] || "v";
    var cleaned = [];

    // Remove existing metadata arguments for this stream type
    for (var i = 0; i < outputArgs.length; i += 1) {
        var arg = outputArgs[i];
        var isMetadataArg = new RegExp("^-metadata:s:".concat(selector)).test(arg);
        if (isMetadataArg) {
            // Skip this arg and the next one (the value)
            i += 1;
            continue;
        }
        cleaned.push(arg);
    }

    // Add metadata removal arguments (setting to empty string removes it)
    // Clear both title and handler_name to ensure complete removal
    cleaned.push("-metadata:s:".concat(selector, ":{outputTypeIndex}"));
    cleaned.push("title=");
    cleaned.push("-metadata:s:".concat(selector, ":{outputTypeIndex}"));
    cleaned.push("handler_name=");

    return cleaned;
};
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
var hasExistingMetadata = function (stream, container) {
    var tags = stream.tags || {};
    // Check if any metadata exists
    return Boolean(tags.title || tags.handler_name);
};
var plugin = function (args) {
    var lib = require("../../../../../methods/lib")();
    var inputs = lib.loadDefaultValues(normalizeInputs(args.inputs), details);
    args.inputs = inputs;
    flowUtils.checkFfmpegCommandInit(args);

    var removeVideoMetadata = inputs.removeVideoMetadata === true || inputs.removeVideoMetadata === "true";
    var removeAudioMetadata = inputs.removeAudioMetadata === true || inputs.removeAudioMetadata === "true";

    if (!removeVideoMetadata && !removeAudioMetadata) {
        args.jobLog("No metadata removal requested.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    var streams = args.variables.ffmpegCommand.streams || [];
    var container = normalize((args.inputFileObj || {}).container || "");

    if (streams.length === 0) {
        args.jobLog("No mapped streams to update.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    // Get metadata from input file to check which streams have metadata
    var metaStreams = getStreams(args.inputFileObj);
    var metaByIndex = new Map();
    metaStreams.forEach(function (s) { metaByIndex.set(s.index, s); });

    var changed = false;
    var newStreams = streams.map(function (stream) {
        var shouldProcess = (stream.codec_type === "video" && removeVideoMetadata)
            || (stream.codec_type === "audio" && removeAudioMetadata);

        if (!shouldProcess) {
            return stream;
        }

        // Get metadata for this stream from the input file
        var metaStream = metaByIndex.get(stream.index);
        if (!metaStream || !hasExistingMetadata(metaStream, container)) {
            return stream;
        }

        var updatedArgs = removeMetadataArgs(stream.outputArgs || [], stream.codec_type, container);

        if ((stream.outputArgs || []).join("|") !== updatedArgs.join("|")) {
            changed = true;
        }

        return Object.assign({}, stream, {
            outputArgs: updatedArgs,
        });
    });

    if (!changed) {
        args.jobLog("No metadata to remove; streams already clean.");
        console.log("streamMetadataRemove: no-change (no metadata found)");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    var overallOutputArgs = buildOverallOutputArgs(newStreams);

    console.log("streamMetadataRemove: setting streams/args", {
        streams: newStreams,
        overallOutputArgs: overallOutputArgs,
    });

    args.variables.ffmpegCommand.streams = newStreams;
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
