"use strict";
var flowUtils = require("../../../../FlowHelpers/1.0.0/interfaces/flowUtils");
var commentaryRegex = /commentary|narration|descriptive|director|producer|writer/i;
var codecTypeSelector = {
    video: "v",
    audio: "a",
    subtitle: "s",
    data: "d",
    attachment: "t",
};
var normalize = function (value) {
    return (value || "").toString().toLowerCase().trim();
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
var normalizeList = function (value) {
    return normalize(value)
        .split(",")
        .map(function (part) { return part.trim(); })
        .filter(function (part) { return part.length > 0; });
};
var getInputValue = function (inputs, name, fallback) {
    var input = inputs.find(function (i) { return i.name === name; });
    if (!input || typeof input.value === "undefined") {
        return fallback;
    }
    return input.value;
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
var isCommentary = function (stream) {
    var title = (stream.title
        || (stream.tags && (stream.tags.title || stream.tags.handler_name))
        || "").toString();
    return commentaryRegex.test(title);
};
var bitrateToNumber = function (bitrate) {
    if (!bitrate) {
        return 0;
    }
    if (typeof bitrate === "number") {
        return bitrate;
    }
    var cleaned = String(bitrate).trim().toLowerCase();
    if (/^\d+\s*k$/.test(cleaned)) {
        return parseInt(cleaned, 10) * 1000;
    }
    var numeric = cleaned.replace(/[^0-9]/g, "");
    return numeric ? parseInt(numeric, 10) : 0;
};
var getStreamBitrate = function (stream) {
    return bitrateToNumber(stream.bit_rate || (stream.tags && stream.tags.BPS));
};
var getMapArgs = function (stream) {
    var selector = codecTypeSelector[stream.codec_type] || stream.codec_type || "";
    var typeIndex = typeof stream.typeIndex === "number" ? stream.typeIndex : 0;
    var optional = (selector === "v" || selector === "t") ? "" : "?";
    return ["-map", "0:".concat(selector, ":").concat(typeIndex).concat(optional)];
};
var parseDisposition = function (outputArgs) {
    for (var i = 0; i < outputArgs.length - 1; i += 1) {
        if (/^-disposition:a/.test(outputArgs[i])) {
            var value = outputArgs[i + 1] || "";
            return {
                default: /default/.test(value),
                raw: value,
            };
        }
    }
    return { default: null, raw: null };
};
var updateDisposition = function (outputArgs, makeDefault) {
    var cleaned = [];
    for (var i = 0; i < outputArgs.length; i += 1) {
        var arg = outputArgs[i];
        if (/^-disposition:a/.test(arg)) {
            i += 1;
            continue;
        }
        cleaned.push(arg);
    }
    cleaned.push("-disposition:a:{outputTypeIndex}");
    cleaned.push(makeDefault ? "default" : "0");
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
var details = function () { return ({
    name: "Reorder Audio Streams",
    description: "Reorders audio streams by codec and language preference and sets a non-commentary stream as default.",
    style: {
        borderColor: "purple",
    },
    tags: "audio",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: 2,
    icon: "faSortAmountDown",
    inputs: [
        {
            name: "Codec Order",
            type: "string",
            defaultValue: "eac3,ac3,aac,truehd,dts,dtshd",
            inputUI: "text",
            tooltip: "Comma-separated codec preference (first = highest priority).",
        },
        {
            name: "Language Order",
            type: "string",
            defaultValue: "original,eng",
            inputUI: "text",
            tooltip: "Comma-separated language preference. Use 'original' for the source language.",
        },
        {
            name: "Precedence",
            type: "string",
            defaultValue: "Codec Order",
            inputUI: {
                type: "dropdown",
                options: ["Codec Order", "Language Order"],
            },
            tooltip: "Choose whether codec or language is sorted first.",
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
var plugin = function (args) {
    var lib = require("../../../../../methods/lib")();
    var inputs = lib.loadDefaultValues(normalizeInputs(args.inputs), details);
    args.inputs = inputs;
    flowUtils.checkFfmpegCommandInit(args);
    var codecOrderInput = normalize(getInputValue(inputs, "Codec Order", ""));
    var languageOrderInput = normalize(getInputValue(inputs, "Language Order", ""));
    var precedence = getInputValue(inputs, "Precedence", "Codec Order");
    var codecOrder = normalizeList(codecOrderInput);
    var languageOrder = normalizeList(languageOrderInput);
    var allStreams = getStreams(args.inputFileObj);
    var audioMeta = allStreams.filter(function (s) { return s.codec_type === "audio"; });
    var nativeLanguage = normalize((audioMeta[0] && audioMeta[0].tags && audioMeta[0].tags.language) || "");
    var resolveLanguage = function (lang) {
        if (lang === "original") {
            return nativeLanguage;
        }
        return lang;
    };
    var orderedLanguages = languageOrder.map(resolveLanguage);
    var streams = args.variables.ffmpegCommand.streams || [];
    var originalStreams = streams.slice();
    var audioStreams = streams.filter(function (s) { return s.codec_type === "audio"; });
    var otherStreams = streams.filter(function (s) { return s.codec_type !== "audio"; });
    if (audioStreams.length === 0) {
        args.jobLog("No audio streams to reorder.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var metaByIndex = new Map();
    audioMeta.forEach(function (stream) {
        metaByIndex.set(stream.index, stream);
    });
    var getCodecRank = function (codec) {
        var idx = codecOrder.indexOf(normalize(codec));
        return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };
    var getLanguageRank = function (lang) {
        var normalized = normalize(lang);
        var resolved = resolveLanguage(normalized);
        var idx = orderedLanguages.indexOf(resolved);
        return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };
    var sortable = audioStreams.map(function (stream, idx) {
        var meta = metaByIndex.get(stream.index) || {};
        var codec = normalize(meta.codec_name || stream.codec_name || "");
        var lang = normalize((meta.tags && meta.tags.language) || "");
        var commentary = isCommentary(meta);
        var channels = meta.channels || 0;
        var bitrate = getStreamBitrate(meta);
        return {
            stream: stream,
            codec: codec,
            codecRank: getCodecRank(codec),
            lang: lang,
            langRank: getLanguageRank(lang),
            commentary: commentary ? 1 : 0,
            channels: channels,
            bitrate: bitrate,
            originalIndex: idx,
        };
    });
    sortable.sort(function (a, b) {
        var primaryA = precedence === "Language Order" ? a.langRank : a.codecRank;
        var primaryB = precedence === "Language Order" ? b.langRank : b.codecRank;
        if (primaryA !== primaryB) {
            return primaryA - primaryB;
        }
        var secondaryA = precedence === "Language Order" ? a.codecRank : a.langRank;
        var secondaryB = precedence === "Language Order" ? b.codecRank : b.langRank;
        if (secondaryA !== secondaryB) {
            return secondaryA - secondaryB;
        }
        if (a.commentary !== b.commentary) {
            return a.commentary - b.commentary;
        }
        if (a.channels !== b.channels) {
            return b.channels - a.channels;
        }
        if (a.bitrate !== b.bitrate) {
            return b.bitrate - a.bitrate;
        }
        return a.originalIndex - b.originalIndex;
    });
    // If ordering already matches and default disposition is already on the target stream, skip changes.
    var targetDefaultIndex = sortable.findIndex(function (item) { return item.commentary === 0; });
    if (targetDefaultIndex === -1) {
        targetDefaultIndex = 0;
    }
    var targetDefaultId = sortable[targetDefaultIndex].stream.index;
    var currentDefaultId = (function () {
        for (var i = 0; i < audioStreams.length; i += 1) {
            var parsed = parseDisposition(audioStreams[i].outputArgs || []);
            var existingDefault = parsed.default !== null ? parsed.default : (audioStreams[i].disposition && audioStreams[i].disposition.default === 1);
            if (existingDefault) {
                return audioStreams[i].index;
            }
        }
        return null;
    })();
    var orderMatches = audioStreams.length === sortable.length
        && audioStreams.every(function (s, idx) { return s.index === sortable[idx].stream.index; });
    if (orderMatches && currentDefaultId === targetDefaultId) {
        args.jobLog("Audio order already matches desired priority; no remapping needed.");
        console.log("audioReorder: no-change (order already correct)");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var reorderedAudio = [];
    var firstDefaultIndex = sortable.findIndex(function (item) { return item.commentary === 0; });
    if (firstDefaultIndex === -1) {
        firstDefaultIndex = 0;
    }
    var changed = false;
    sortable.forEach(function (item, idx) {
        var makeDefault = idx === firstDefaultIndex;
        var updatedOutputArgs = item.stream.outputArgs || [];
        var parsed = parseDisposition(updatedOutputArgs);
        var existingDefault = parsed.default !== null ? parsed.default : (item.stream.disposition && item.stream.disposition.default === 1);
        if (existingDefault !== makeDefault) {
            updatedOutputArgs = updateDisposition(updatedOutputArgs, makeDefault);
        }
        if (idx !== item.originalIndex) {
            changed = true;
        }
        if ((item.stream.outputArgs || []).join("|") !== updatedOutputArgs.join("|")) {
            changed = true;
        }
        reorderedAudio.push(Object.assign({}, item.stream, {
            // Preserve original mapping (which may include a specific sourceTypeIndex).
            mapArgs: item.stream.mapArgs || getMapArgs(item.stream),
            outputArgs: updatedOutputArgs,
            sourceTypeIndex: item.stream.sourceTypeIndex,
        }));
    });
    // Reinsert reordered audio streams back into their original audio slot positions
    var outputStreams = streams.slice();
    var audioPositions = [];
    streams.forEach(function (s, idx) {
        if (s.codec_type === "audio") {
            audioPositions.push(idx);
        }
    });
    audioPositions.forEach(function (pos, idx) {
        outputStreams[pos] = reorderedAudio[idx];
    });
    if (!changed) {
        args.jobLog("Audio order already matches desired priority; no remapping needed.");
        console.log("audioReorder: no-change (order already correct)");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var overallOutputArgs = buildOverallOutputArgs(outputStreams);
    // If the resulting mapping/args are identical to what we already had, skip processing.
    var previousOutputArgs = args.variables.ffmpegCommand.overallOutputArguments || [];
    var streamsEqual = outputStreams.length === originalStreams.length
        && outputStreams.every(function (s, idx) {
            var prev = originalStreams[idx];
            if (!prev) {
                return false;
            }
            var sameIndex = s.index === prev.index && s.codec_type === prev.codec_type && !!s.removed === !!prev.removed;
            var sameMap = (s.mapArgs || []).join("|") === (prev.mapArgs || []).join("|");
            var sameOut = (s.outputArgs || []).join("|") === (prev.outputArgs || []).join("|");
            return sameIndex && sameMap && sameOut;
        });
    var argsEqual = overallOutputArgs.join("|") === previousOutputArgs.join("|");
    if (streamsEqual && argsEqual) {
        args.jobLog("Audio order already matches desired priority; no remapping needed.");
        console.log("audioReorder: no-change (order already correct)");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    console.log("audioReorder: setting reordered streams/args", {
        streams: outputStreams,
        overallOutputArgs: overallOutputArgs,
    });
    args.variables.ffmpegCommand.streams = outputStreams;
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
