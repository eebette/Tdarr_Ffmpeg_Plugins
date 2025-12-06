"use strict";
var flowUtils = require("../../../../FlowHelpers/1.0.0/interfaces/flowUtils");
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
    name: "Video: Standardize Codec Name",
    description: "Sets video stream titles to '<resolution> <CODEC> <HDR/SDR>' or 'Dolby Vision Profile x.x (HDR10/HDR)'.",
    style: {
        borderColor: "blue",
    },
    tags: "video",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: 3,
    icon: "faAlignCenter",
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
var formatResolution = function (stream) {
    // Use both width and height so cropped bars still map to the intended tier.
    var height = stream.height || (stream.tags && stream.tags.height) || 0;
    var width = stream.width || (stream.tags && stream.tags.width) || 0;
    if (height >= 2160 || width >= 3800) {
        return "4K";
    }
    if (height >= 1440 || width >= 2500) {
        return "1440p";
    }
    if (height >= 1000 || width >= 1900) {
        return "1080p";
    }
    if (height >= 700 || width >= 1200) {
        return "720p";
    }
    if (height > 0) {
        return "".concat(height, "p");
    }
    return "SD";
};
var detectHdrLabel = function (stream) {
    var codecName = normalize(stream.codec_name || "");
    var profile = (stream.profile || "").toString();
    var transfer = normalize(stream.color_transfer || "");
    var hdrTransfer = transfer === "smpte2084";
    var hlg = transfer === "arib-std-b67" || /hlg/.test(transfer);
    var dvInfo = getDolbyVisionInfo(stream, codecName, profile);
    if (dvInfo.isDolbyVision) {
        var base = hdrTransfer ? "HDR10" : "HDR";
        return "Dolby Vision Profile ".concat(dvInfo.profileText, " (").concat(base, ")");
    }
    if (hdrTransfer) {
        return "HDR10";
    }
    if (hlg) {
        return "HDR";
    }
    return "SDR";
};
var getDolbyVisionInfo = function (stream, codecName, profile) {
    var sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
    var tags = stream.tags || {};
    var handler = normalize(tags.handler_name || "");
    var hasDoviSideData = sideData.some(function (entry) {
        var entryType = normalize(entry.side_data_type || "");
        return entryType === "dovi configuration record" || entryType.includes("dovi");
    });
    var dvCodec = /^dv/.test(codecName) || codecName.includes("dovi");
    var handlerHasDv = /dolby\s*vision|dovi/.test(handler);
    var profileHasDv = /dolby\s*vision/i.test(profile);
    var dvConfig = sideData.find(function (entry) { return normalize(entry.side_data_type || "") === "dovi configuration record"; }) || {};
    var configProfile = typeof dvConfig.dv_profile === "number" ? dvConfig.dv_profile : null;
    var compatId = typeof dvConfig.dv_bl_signal_compatibility_id === "number" ? dvConfig.dv_bl_signal_compatibility_id : null;
    var handlerMatch = handler.match(/dvp\s*=\s*([0-9]+(?:\.[0-9]+)?)/);
    var handlerProfile = handlerMatch ? handlerMatch[1] : null;
    var profileMatch = (profile.match(/(\d+(?:\.\d+)?)/) || [])[1];
    var inferredProfile = configProfile !== null ? configProfile.toString()
        : (handlerProfile || (dvCodec || hasDoviSideData || handlerHasDv || profileHasDv ? profileMatch : null));
    var hasDvSignal = dvCodec || hasDoviSideData || handlerHasDv || profileHasDv || Boolean(configProfile) || Boolean(handlerProfile);
    if (!hasDvSignal) {
        return { isDolbyVision: false, profileText: "" };
    }
    var profileText = inferredProfile || "Unknown";
    if (inferredProfile && inferredProfile === "8" && compatId !== null) {
        profileText = "8.".concat(compatId);
    }
    return {
        isDolbyVision: true,
        profileText: profileText,
    };
};
var buildTitle = function (stream) {
    var resolution = formatResolution(stream);
    var codec = (stream.codec_name || stream.codec_tag_string || "video").toString().toUpperCase();
    var hdr = detectHdrLabel(stream);
    return "".concat(resolution, " ").concat(codec, " ").concat(hdr);
};
var setMetadataArg = function (outputArgs, title, stream, container) {
    var isMkv = normalize(container) === "mkv";
    var metadataKey = isMkv ? "title" : "handler_name";
    var cleaned = [];
    var existingValue = "";
    for (var i = 0; i < outputArgs.length; i += 1) {
        var arg = outputArgs[i];
        if (/^-metadata:s:v/.test(arg)) {
            if (i + 1 < outputArgs.length && outputArgs[i + 1].indexOf("".concat(metadataKey, "=")) === 0) {
                existingValue = outputArgs[i + 1].split("=").slice(1).join("=");
            }
            i += 1;
            continue;
        }
        cleaned.push(arg);
    }
    // Fall back to stream tags when outputArgs are empty.
    var tagValue = stream.tags ? (isMkv ? stream.tags.title : stream.tags.handler_name) : "";
    var metadataMatches = (existingValue || tagValue) === title;
    if (metadataMatches) {
        // Nothing to change.
        return outputArgs;
    }
    // Refresh the relevant metadata key depending on container type.
    cleaned.push("-metadata:s:v:{outputTypeIndex}");
    cleaned.push("".concat(metadataKey, "=").concat(title));
    return cleaned;
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
var getCodecSelectorForStream = function (streams, stream) {
    var selector = stream.codec_type === "video" ? "v" : (stream.codec_type === "audio" ? "a" : (stream.codec_type === "subtitle" ? "s" : stream.codec_type || ""));
    if (!selector || selector.length !== 1) {
        return "-c:".concat(getOutputStreamIndex(streams, stream));
    }
    return "-c:".concat(selector, ":").concat(getOutputStreamTypeIndex(streams, stream));
};
var applyPlaceholders = function (args, streams, stream) {
    return args.map(function (arg) {
        var updated = arg;
        if (updated.includes("{outputIndex}")) {
            updated = updated.replace("{outputIndex}", String(getOutputStreamIndex(streams, stream)));
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
    var selector = stream.codec_type === "video" ? "v" : (stream.codec_type === "audio" ? "a" : (stream.codec_type === "subtitle" ? "s" : stream.codec_type || ""));
    if (!selector) {
        return mapArgs;
    }
    var mapTarget = "0:".concat(selector, ":").concat(getOutputStreamTypeIndex(streams, stream)).concat(selector === "v" ? "" : "?");
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
    var meta = getStreams(args.inputFileObj).filter(function (s) { return s.codec_type === "video"; });
    if (meta.length === 0) {
        args.jobLog("No video streams found in metadata.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var metaByIndex = new Map();
    meta.forEach(function (s) { metaByIndex.set(s.index, s); });
    var changed = false;
    var newStreams = streams.map(function (stream) {
        if (stream.codec_type !== "video") {
            return stream;
        }
        var metaStream = metaByIndex.get(stream.index) || meta[0];
        var title = buildTitle(metaStream);
        var updatedArgs = setMetadataArg(stream.outputArgs || [], title, stream, container);
        if ((stream.outputArgs || []).join("|") !== updatedArgs.join("|")) {
            changed = true;
        }
        return Object.assign({}, stream, {
            outputArgs: updatedArgs,
        });
    });
    if (!changed) {
        args.jobLog("Video handlers already standardized; no remapping needed.");
        console.log("videoCodecStandardize: no-change (handler_name already standardized)");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var overallOutputArgs = buildOverallOutputArgs(newStreams);
    console.log("videoCodecStandardize: setting streams/args", {
        streams: newStreams,
        overallOutputArgs: overallOutputArgs,
    });
    args.variables.ffmpegCommand.streams = newStreams;
    args.variables.ffmpegCommand.overallOutputArguments = overallOutputArgs;
    args.variables.ffmpegCommand.overallOuputArguments = overallOutputArgs;
    args.variables.ffmpegCommand.shouldProcess = true;
    args.variables.ffmpegCommand.init = true;
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
