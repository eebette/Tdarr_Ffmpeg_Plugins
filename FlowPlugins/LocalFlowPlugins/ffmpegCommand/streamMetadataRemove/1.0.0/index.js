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
var details = function () { return ({
    name: "Stream Metadata: Remove Handler/Title",
    description: "Removes handler_name and title metadata from video, audio, and/or subtitle streams.",
    style: {
        borderColor: "orange",
    },
    tags: "video,audio,subtitle",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: 3,
    icon: "faEraser",
    inputs: [
        {
            label: "Remove video stream metadata",
            name: "removeVideoMetadata",
            inputType: "boolean",
            defaultValue: "true",
            inputUI: {
                type: "switch",
            },
            tooltip: "Remove title and handler_name from video streams.",
        },
        {
            label: "Remove audio stream metadata",
            name: "removeAudioMetadata",
            inputType: "boolean",
            defaultValue: "true",
            inputUI: {
                type: "switch",
            },
            tooltip: "Remove title and handler_name from audio streams.",
        },
        {
            label: "Remove subtitle stream metadata",
            name: "removeSubtitleMetadata",
            inputType: "boolean",
            defaultValue: "true",
            inputUI: {
                type: "switch",
            },
            tooltip: "Remove title and handler_name from subtitle streams.",
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

    // Check for title metadata
    if (tags.title) {
        return true;
    }

    // For MP4/MOV files, ignore default FFmpeg handler names
    // These are automatically added by the muxer and can't be removed
    if (tags.handler_name) {
        var handlerName = tags.handler_name.toLowerCase();
        var isDefaultHandler = handlerName === 'videohandler'
            || handlerName === 'soundhandler'
            || handlerName === 'subtitlehandler';

        if (!isDefaultHandler) {
            return true;
        }
    }

    return false;
};
var plugin = function (args) {
    var lib = require("../../../../../methods/lib")();
    var inputs = lib.loadDefaultValues(args.inputs, details);
    args.inputs = inputs;
    flowUtils.checkFfmpegCommandInit(args);

    var removeVideoMetadata = String(inputs.removeVideoMetadata) === "true";
    var removeAudioMetadata = String(inputs.removeAudioMetadata) === "true";
    var removeSubtitleMetadata = String(inputs.removeSubtitleMetadata) === "true";

    console.log("streamMetadataRemove: input config", {
        removeVideoMetadataRaw: inputs.removeVideoMetadata,
        removeAudioMetadataRaw: inputs.removeAudioMetadata,
        removeSubtitleMetadataRaw: inputs.removeSubtitleMetadata,
        removeVideoMetadata: removeVideoMetadata,
        removeAudioMetadata: removeAudioMetadata,
        removeSubtitleMetadata: removeSubtitleMetadata
    });

    if (!removeVideoMetadata && !removeAudioMetadata && !removeSubtitleMetadata) {
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

    var changed = false;
    var newStreams = streams.map(function (stream) {
        var shouldProcess = (stream.codec_type === "video" && removeVideoMetadata)
            || (stream.codec_type === "audio" && removeAudioMetadata)
            || (stream.codec_type === "subtitle" && removeSubtitleMetadata);

        // Debug: log ALL streams
        console.log("streamMetadataRemove: processing stream", {
            index: stream.index,
            codec_type: stream.codec_type,
            shouldProcess: shouldProcess,
            tags: stream.tags
        });

        if (!shouldProcess) {
            return stream;
        }

        // Check metadata on the current stream (from the processing flow state)
        // Note: stream indices may differ from original input due to filtering/reordering
        if (!hasExistingMetadata(stream, container)) {
            console.log("streamMetadataRemove: no existing metadata for stream", stream.index);
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


    console.log("streamMetadataRemove: setting streams/args", {
        streams: newStreams,
    });

    args.variables.ffmpegCommand.streams = newStreams;
    args.variables.ffmpegCommand.shouldProcess = true;
    args.variables.ffmpegCommand.init = true;

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
