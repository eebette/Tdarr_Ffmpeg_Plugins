"use strict";
var path = require("path");
var flowUtils = require("../../../../FlowHelpers/1.0.0/interfaces/flowUtils");
var commentaryRegex = /commentary|narration|descriptive|director|producer|writer/i;
var codecTypeSelector = {
    video: "v",
    audio: "a",
    subtitle: "s",
    data: "d",
    attachment: "t",
};
var hdAudioCodecs = [
    "truehd",
    "thd",
    "dts",
    "dtshd",
    "dtsma",
    "dts-hd",
];
var details = function () { return ({
    name: "Audio: Ensure EAC3 Fallback",
    description: "Creates an EAC3 copy for TrueHD/DTS tracks when missing.",
    style: {
        borderColor: "orange",
    },
    tags: "audio",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: 1,
    icon: "faVolumeUp",
    inputs: [],
    outputs: [
        {
            number: 1,
            tooltip: "Continue to next plugin",
        },
    ],
}); };
exports.details = details;
var normalize = function (value) {
    return (value || "").toString().toLowerCase().replace(/[\s_-]/g, "");
};
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
var isHdAudio = function (stream) {
    return stream.codec_type === "audio" && hdAudioCodecs.includes(normalize(stream.codec_name));
};
var isFallbackAudio = function (stream) {
    var codec = normalize(stream.codec_name);
    return stream.codec_type === "audio" && (codec === "eac3" || codec === "ac3" || codec === "aac" || codec === "flac");
};
var getTitleText = function (stream) {
    var tags = stream.tags || {};
    return (stream.title
        || tags.title
        || tags.handler_name
        || tags.language
        || "").toString();
};
var scrubTitle = function (title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\b(truehd|dts[-\s]?hd|dts|ac3|eac3|atmos|surround|stereo|mono|5\.1|7\.1)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
};
var isCommentary = function (stream) {
    var title = getTitleText(stream);
    return commentaryRegex.test(title);
};
var isCompatibilityTrack = function (stream) {
    var title = getTitleText(stream).toLowerCase();
    return /\bcompat(ibility|ible)?\b/.test(title);
};
var streamsLikelyMatch = function (hdStream, candidate) {
    if (isCommentary(candidate)) {
        return false;
    }
    var compat = isCompatibilityTrack(candidate);
    var hdLang = (hdStream.tags && normalize(hdStream.tags.language)) || "";
    var candLang = (candidate.tags && normalize(candidate.tags.language)) || "";
    if (hdLang && candLang && hdLang !== candLang) {
        return false;
    }
    if (!compat) {
        // Allow fallback streams with same OR fewer channels (downmixing is expected)
        if (hdStream.channels && candidate.channels && candidate.channels > hdStream.channels) {
            return false;
        }
        // Don't enforce strict channel_layout matching - fallbacks are often downmixed
        // If both layouts exist and are different, only reject if channels are identical
        // (same channel count with different layout suggests they're different tracks)
        var hdLayout = normalize(hdStream.channel_layout || "");
        var candLayout = normalize(candidate.channel_layout || "");
        if (hdLayout && candLayout && hdLayout !== candLayout && hdStream.channels === candidate.channels) {
            return false;
        }
    }
    var hdTitle = scrubTitle(getTitleText(hdStream));
    var candTitle = scrubTitle(getTitleText(candidate));
    if (hdTitle && candTitle) {
        return hdTitle === candTitle;
    }
    return true;
};
var getMapArgs = function (stream) {
    var selector = codecTypeSelector[stream.codec_type] || stream.codec_type || "";
    var typeIndex = typeof stream.typeIndex === "number" ? stream.typeIndex : 0;
    var optional = (selector === "v" || selector === "t") ? "" : "?";
    return ["-map", "0:".concat(selector, ":").concat(typeIndex).concat(optional)];
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
var getCodecSelectorForStream = function (streams, stream) {
    var selector = codecTypeSelector[stream.codec_type];
    if (!selector) {
        return "-c:".concat(getOutputStreamIndex(streams, stream));
    }
    return "-c:".concat(selector, ":").concat(getOutputStreamTypeIndex(streams, stream));
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
var pickBitrate = function (stream) {
    var channels = stream.channels || 2;
    if (channels >= 8) {
        return "896k";
    }
    if (channels >= 6) {
        return "640k";
    }
    if (channels >= 2) {
        return "320k";
    }
    return "192k";
};
var makeCopyArgs = function (stream, makeDefault) {
    var selector = codecTypeSelector[stream.codec_type] || stream.codec_type || "a";
    var disposition = makeDefault ? "default" : "0";
    if (stream.codec_type === "audio") {
        return ["-c:".concat(selector), "copy", "-disposition:a:{outputTypeIndex}", disposition];
    }
    return ["-c:".concat(selector), "copy"];
};
var makeEac3Args = function (sourceAudio, makeDefault) {
    var disposition = makeDefault ? "default" : "0";
    var bitrate = pickBitrate(sourceAudio);
    return [
        "-c:a",
        "eac3",
        "-b:a",
        bitrate,
        "-disposition:a:{outputTypeIndex}",
        disposition,
    ];
};
var buildAudioPlan = function (audioStreams, hdStreams, matches, conversions) {
    var added = new Set();
    var plan = [];
    var addEntry = function (entry) {
        plan.push(entry);
        added.add(entry.id);
    };
    hdStreams.forEach(function (stream) {
        var hdId = stream.index;
        var needsConversion = conversions.some(function (s) { return s.index === hdId; });
        var matched = matches.get(hdId);
        if (needsConversion) {
            addEntry({
                id: "new-eac3-".concat(hdId),
                action: "transcode",
                source: stream,
                makeDefault: false,
            });
        }
        if (!added.has(hdId)) {
            addEntry({
                id: hdId,
                action: "copy",
                source: stream,
                makeDefault: false,
            });
        }
        if (matched && !added.has(matched.index)) {
            addEntry({
                id: matched.index,
                action: "copy",
                source: matched,
                makeDefault: false,
            });
        }
    });
    audioStreams.forEach(function (stream) {
        if (!added.has(stream.index)) {
            addEntry({
                id: stream.index,
                action: "copy",
                source: stream,
                makeDefault: false,
            });
        }
    });
    return plan;
};
var plugin = function (args) {
    var lib = require("../../../../../methods/lib")();
    var inputs = lib.loadDefaultValues(normalizeInputs(args.inputs), details);
    args.inputs = inputs;
    flowUtils.checkFfmpegCommandInit(args);

    // Check if we have existing flow state from previous plugins
    var useFlowState = args.variables.ffmpegCommand.streams
        && Array.isArray(args.variables.ffmpegCommand.streams)
        && args.variables.ffmpegCommand.streams.length > 0;

    // Get original metadata for all streams (needed for codec detection)
    var allMetaStreams = getStreams(args.inputFileObj);
    var metaByIndex = new Map();
    allMetaStreams.forEach(function (stream) {
        metaByIndex.set(stream.index, stream);
    });

    var videoStreams, audioStreams, subtitleStreams, attachmentStreams;

    if (useFlowState) {
        // Read from flow state - this respects previous plugin modifications
        var flowStreams = args.variables.ffmpegCommand.streams;
        videoStreams = flowStreams.filter(function (s) { return s.codec_type === "video" && !s.removed; });
        audioStreams = flowStreams.filter(function (s) { return s.codec_type === "audio" && !s.removed; });
        subtitleStreams = flowStreams.filter(function (s) { return s.codec_type === "subtitle" && !s.removed; });
        attachmentStreams = flowStreams.filter(function (s) {
            return (s.codec_type === "attachment" || s.codec_type === "data") && !s.removed;
        });
    } else {
        // Fall back to reading from original file
        videoStreams = allMetaStreams.filter(function (s) { return s.codec_type === "video"; });
        audioStreams = allMetaStreams.filter(function (s) { return s.codec_type === "audio"; });
        subtitleStreams = allMetaStreams.filter(function (s) { return s.codec_type === "subtitle"; });
        attachmentStreams = allMetaStreams.filter(function (s) {
            return s.codec_type === "attachment" || s.codec_type === "data";
        });
    }

    if (audioStreams.length === 0) {
        args.jobLog("File has no audio streams; skipping.");
        args.variables.ffmpegCommand.shouldProcess = false;
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    // Identify HD audio streams - use original metadata for codec detection
    var hdStreams = audioStreams.filter(function (stream) {
        var meta = metaByIndex.get(stream.index) || stream;
        return isHdAudio(meta);
    });

    var fallbackStreams = audioStreams.filter(function (stream) {
        var meta = metaByIndex.get(stream.index) || stream;
        return isFallbackAudio(meta);
    });

    // Match HD streams with existing fallbacks
    var matches = new Map();
    var usedEac3 = new Set();
    hdStreams.forEach(function (stream) {
        var hdMeta = metaByIndex.get(stream.index) || stream;
        var match = fallbackStreams.find(function (candidate) {
            if (usedEac3.has(candidate.index)) {
                return false;
            }
            var candidateMeta = metaByIndex.get(candidate.index) || candidate;
            return streamsLikelyMatch(hdMeta, candidateMeta);
        });
        if (match) {
            matches.set(stream.index, match);
            usedEac3.add(match.index);
        }
    });

    var conversions = hdStreams.filter(function (stream) { return !matches.has(stream.index); });
    var shouldProcess = conversions.length > 0;

    if (!shouldProcess) {
        args.jobLog("Audio already has suitable fallback; no changes needed.");
        console.log("audioEAC3Fallback: no-change (existing fallback present)");
        args.variables.ffmpegCommand.shouldProcess = false;
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    var outputStreams = [];

    // Preserve video streams from flow state (or original file)
    videoStreams.forEach(function (stream) {
        if (useFlowState) {
            // Keep existing stream with all modifications
            outputStreams.push(stream);
        } else {
            // Build new stream entry
            outputStreams.push({
                index: stream.index,
                codec_type: "video",
                mapArgs: getMapArgs(stream),
                outputArgs: makeCopyArgs(stream, false),
                inputArgs: [],
                typeIndex: typeof stream.typeIndex === "number" ? stream.typeIndex : undefined,
                removed: false,
            });
        }
    });

    // Build audio plan based on HD streams and needed conversions
    var audioPlan = buildAudioPlan(audioStreams, hdStreams, matches, conversions);

    audioPlan.forEach(function (entry) {
        var sourceMeta = metaByIndex.get(entry.source.index) || entry.source;

        if (entry.action === "transcode") {
            // Create new EAC3 stream
            var tags = sourceMeta.tags || {};
            outputStreams.push({
                index: entry.id,
                codec_type: "audio",
                codec_name: "eac3",
                channels: sourceMeta.channels,
                channel_layout: sourceMeta.channel_layout,
                tags: {
                    language: tags.language,
                    title: tags.title,
                    handler_name: tags.handler_name,
                    BPS: tags.BPS,
                },
                mapArgs: getMapArgs(sourceMeta),
                outputArgs: makeEac3Args(sourceMeta, false),
                inputArgs: [],
                sourceTypeIndex: typeof sourceMeta.typeIndex === "number" ? sourceMeta.typeIndex : undefined,
                typeIndex: typeof sourceMeta.typeIndex === "number" ? sourceMeta.typeIndex : undefined,
                removed: false,
            });
        } else {
            // Copy existing stream
            if (useFlowState) {
                // Keep existing stream with all modifications from previous plugins
                outputStreams.push(entry.source);
            } else {
                // Build new stream entry
                var tags = sourceMeta.tags || {};
                outputStreams.push({
                    index: entry.source.index,
                    codec_type: "audio",
                    codec_name: sourceMeta.codec_name,
                    channels: sourceMeta.channels,
                    channel_layout: sourceMeta.channel_layout,
                    tags: {
                        language: tags.language,
                        title: tags.title,
                        handler_name: tags.handler_name,
                        BPS: tags.BPS,
                    },
                    mapArgs: entry.source.mapArgs || getMapArgs(sourceMeta),
                    outputArgs: entry.source.outputArgs || makeCopyArgs(entry.source, false),
                    inputArgs: [],
                    sourceTypeIndex: typeof entry.source.sourceTypeIndex === "number"
                        ? entry.source.sourceTypeIndex
                        : (typeof sourceMeta.typeIndex === "number" ? sourceMeta.typeIndex : undefined),
                    typeIndex: typeof sourceMeta.typeIndex === "number" ? sourceMeta.typeIndex : undefined,
                    removed: false,
                });
            }
        }
    });

    // Preserve subtitle streams from flow state (or original file)
    subtitleStreams.forEach(function (stream) {
        if (useFlowState) {
            // Keep existing stream with all modifications
            outputStreams.push(stream);
        } else {
            // Build new stream entry
            outputStreams.push({
                index: stream.index,
                codec_type: "subtitle",
                mapArgs: getMapArgs(stream),
                outputArgs: makeCopyArgs(stream, false),
                inputArgs: [],
                typeIndex: typeof stream.typeIndex === "number" ? stream.typeIndex : undefined,
                removed: false,
            });
        }
    });

    // Preserve attachment streams from flow state (or original file)
    attachmentStreams.forEach(function (stream) {
        if (useFlowState) {
            // Keep existing stream with all modifications
            outputStreams.push(stream);
        } else {
            // Build new stream entry
            outputStreams.push({
                index: stream.index,
                codec_type: stream.codec_type,
                mapArgs: getMapArgs(stream),
                outputArgs: makeCopyArgs(stream, false),
                inputArgs: [],
                typeIndex: typeof stream.typeIndex === "number" ? stream.typeIndex : undefined,
                removed: false,
            });
        }
    });

    var extension = path.extname(args.inputFileObj._id || "").replace(".", "");
    // Respect an already chosen container; otherwise fall back to the input's container/extension.
    var container = args.variables.ffmpegCommand.container
        || args.inputFileObj.container
        || extension
        || "mkv";

    var overallOutputArgs = buildOverallOutputArgs(outputStreams);

    console.log("audioEAC3Fallback: setting streams/args", {
        useFlowState: useFlowState,
        streams: outputStreams,
        overallOutputArgs: overallOutputArgs,
    });

    args.variables.ffmpegCommand.streams = outputStreams;
    args.variables.ffmpegCommand.overallInputArguments = [];
    args.variables.ffmpegCommand.overallOutputArguments = overallOutputArgs;
    args.variables.ffmpegCommand.shouldProcess = true;
    args.variables.ffmpegCommand.container = container;
    args.variables.ffmpegCommand.init = true;

    args.jobLog(JSON.stringify({
        matches: Array.from(matches.values()).map(function (stream) { return stream.index; }),
        conversions: conversions.map(function (stream) { return stream.index; }),
    }));

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
