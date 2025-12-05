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
var mp4CompatibleCodecs = ["mov_text", "tx3g"];
var textConvertibleCodecs = [
    "subrip", "srt", "ass", "ssa", "webvtt", "text", "utf8", "usf", "microdvd", "mpl2", "sami", "smi",
];
var imageCodecs = ["hdmv_pgs_subtitle", "pgs", "dvb_subtitle", "dvd_subtitle", "xsub", "vobsub"];
var isMp4Container = function (container) {
    var c = normalize(container);
    return c === "mp4" || c === "m4v" || c === "mov";
};
var stripCodecArgs = function (outputArgs) {
    var cleaned = [];
    for (var i = 0; i < outputArgs.length; i += 1) {
        var arg = outputArgs[i];
        if (/^-(?:c|codec)(?::[a-z]+(?::\\d+)?)?$/i.test(arg)) {
            i += 1;
            continue;
        }
        cleaned.push(arg);
    }
    return cleaned;
};
var commentaryRegex = /commentary|narration|descriptive|director|producer|writer/i;
var codecTypeSelector = {
    video: "v",
    audio: "a",
    subtitle: "s",
    data: "d",
    attachment: "t",
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
    var selector = codecTypeSelector[stream.codec_type];
    if (!selector) {
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
    var selector = codecTypeSelector[stream.codec_type] || stream.codec_type || "";
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
var extractLanguageFromOutputArgs = function (outputArgs) {
    for (var i = 0; i < outputArgs.length - 1; i += 1) {
        if (/^-metadata:s:s/.test(outputArgs[i]) && /^language=/.test(outputArgs[i + 1])) {
            return outputArgs[i + 1].split("=")[1];
        }
    }
    return "";
};
var detectTypeLabel = function (meta) {
    var commentary = commentaryRegex.test((meta.title
        || (meta.tags && (meta.tags.title || meta.tags.handler_name))
        || "").toString());
    var forced = Boolean(meta.disposition && meta.disposition.forced);
    if (commentary) {
        return "commentary";
    }
    if (forced) {
        return "forced";
    }
    return "normal";
};
var details = function () { return ({
    name: "Subtitles: Convert to mov_text (MP4)",
    description: "Converts subtitle streams that MP4 cannot store (e.g., SRT/ASS) to mov_text/tx3g so mp4 muxing succeeds, and drops image-based subtitles MP4 cannot hold.",
    style: {
        borderColor: "teal",
    },
    tags: "subtitle",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: 6,
    icon: "faClosedCaptioning",
    inputs: [],
    outputs: [
        {
            number: 1,
            tooltip: "Continue to next plugin",
        },
    ],
}); };
exports.details = details;
var plugin = function (args) {
    var lib = require("../../../../../methods/lib")();
    var inputs = lib.loadDefaultValues(normalizeInputs(args.inputs), details);
    args.inputs = inputs;
    flowUtils.checkFfmpegCommandInit(args);
    var targetContainer = args.variables.ffmpegCommand.container
        || args.inputFileObj.container
        || ((args.inputFileObj._id || "").split(".").pop());
    if (!isMp4Container(targetContainer || "")) {
        args.jobLog("Target container is not MP4/M4V; subtitle conversion not required.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var mappedStreams = args.variables.ffmpegCommand.streams || [];
    if (mappedStreams.length === 0) {
        args.jobLog("No mapped streams to convert.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var metaByIndex = new Map();
    getStreams(args.inputFileObj).forEach(function (s) {
        metaByIndex.set(s.index, s);
    });
    var changed = false;
    var conversions = 0;
    var removals = 0;
    var imageRemovals = 0;
    var duplicateRemovals = 0;
    var updatedStreams = mappedStreams.map(function (stream) {
        if (stream.removed || stream.codec_type !== "subtitle") {
            return stream;
        }
        var meta = metaByIndex.get(stream.index) || {};
        var codec = normalize(stream.codec_name || meta.codec_name || "");
        if (mp4CompatibleCodecs.indexOf(codec) !== -1) {
            return stream;
        }
        if (textConvertibleCodecs.indexOf(codec) !== -1 || codec.length === 0) {
            var cleaned = stripCodecArgs(stream.outputArgs || []);
            var updatedArgs = ["-c:s", "mov_text"].concat(cleaned);
            changed = true;
            conversions += 1;
            return Object.assign({}, stream, {
                outputArgs: updatedArgs,
                codec_name: "mov_text",
            });
        }
        if (imageCodecs.indexOf(codec) !== -1) {
            removals += 1;
            imageRemovals += 1;
            changed = true;
            return Object.assign({}, stream, { removed: true });
        }
        // Unknown subtitle codec: try converting anyway to avoid MP4 mux failure.
        var cleanedUnknown = stripCodecArgs(stream.outputArgs || []);
        var updatedUnknownArgs = ["-c:s", "mov_text"].concat(cleanedUnknown);
        changed = true;
        conversions += 1;
        return Object.assign({}, stream, {
            outputArgs: updatedUnknownArgs,
            codec_name: "mov_text",
        });
    });
    var seen = new Set();
    updatedStreams = updatedStreams.map(function (stream) {
        if (stream.removed || stream.codec_type !== "subtitle") {
            return stream;
        }
        var meta = metaByIndex.get(stream.index) || {};
        var lang = normalize((stream.language
            || (meta.tags && meta.tags.language)
            || extractLanguageFromOutputArgs(stream.outputArgs || [])
            || ""));
        var typeLabel = detectTypeLabel(meta);
        var key = "".concat(lang, "|").concat(typeLabel);
        if (seen.has(key)) {
            removals += 1;
            duplicateRemovals += 1;
            changed = true;
            return Object.assign({}, stream, { removed: true });
        }
        seen.add(key);
        return stream;
    });
    if (changed) {
        var keptStreams = updatedStreams.filter(function (s) { return !s.removed; });
        var overallOutputArgs = buildOverallOutputArgs(keptStreams);
        args.variables.ffmpegCommand.streams = keptStreams;
        args.variables.ffmpegCommand.overallOutputArguments = overallOutputArgs;
        args.variables.ffmpegCommand.overallOuputArguments = overallOutputArgs;
        args.variables.ffmpegCommand.shouldProcess = true;
        args.variables.ffmpegCommand.init = true;
        if (conversions > 0) {
            args.jobLog("Converted ".concat(conversions, " subtitle stream(s) to mov_text for MP4 compatibility."));
        }
        if (imageRemovals > 0) {
            args.jobLog("Removed ".concat(imageRemovals, " image-based subtitle stream(s) not supported in MP4."));
        }
        if (duplicateRemovals > 0) {
            args.jobLog("Removed ".concat(duplicateRemovals, " duplicate subtitle stream(s)."));
        }
    }
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
