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
var getMapArgs = function (stream) {
    var selector = codecTypeSelector[stream.codec_type] || stream.codec_type || "";
    var typeIndex = typeof stream.typeIndex === "number" ? stream.typeIndex : 0;
    return ["-map", "0:".concat(selector, ":").concat(typeIndex, "?")];
};
var updateDisposition = function (outputArgs, makeDefault, makeForced) {
    var cleaned = [];
    for (var i = 0; i < outputArgs.length; i += 1) {
        var arg = outputArgs[i];
        if (/^-disposition:s/.test(arg)) {
            i += 1;
            continue;
        }
        cleaned.push(arg);
    }
    cleaned.push("-disposition:s:{outputTypeIndex}");
    var flags = [];
    if (makeDefault) {
        flags.push("default");
    }
    if (makeForced) {
        flags.push("forced");
    }
    if (flags.length === 0) {
        flags.push("0");
    }
    cleaned.push(flags.join("+"));
    return cleaned;
};
var details = function () { return ({
    name: "Reorder Subtitles",
    description: "Reorders subtitle streams by codec and/or language preference and sets the first non-commentary subtitle as default.",
    style: {
        borderColor: "teal",
    },
    tags: "subtitle",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: 7,
    icon: "faClosedCaptioning",
    inputs: [
        {
            name: "Codec Order",
            type: "string",
            defaultValue: "srt,ass,ssa,subrip,pgs,hdmv_pgs_subtitle",
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
    var allMetaStreams = getStreams(args.inputFileObj);
    var subtitleMeta = allMetaStreams.filter(function (s) { return s.codec_type === "subtitle"; });
    var nativeLanguage = normalize((subtitleMeta[0] && subtitleMeta[0].tags && subtitleMeta[0].tags.language) || "");
    var resolveLanguage = function (lang) {
        if (lang === "original") {
            return nativeLanguage;
        }
        return lang;
    };
    var orderedLanguages = languageOrder.map(resolveLanguage);
    var streams = args.variables.ffmpegCommand.streams || [];
    var subtitleStreams = streams.filter(function (s) { return s.codec_type === "subtitle"; });
    var otherStreams = streams.filter(function (s) { return s.codec_type !== "subtitle"; });
    if (subtitleStreams.length === 0) {
        args.jobLog("No subtitle streams to reorder.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var metaByIndex = new Map();
    subtitleMeta.forEach(function (stream) {
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
    var sortable = subtitleStreams.map(function (stream, idx) {
        var meta = metaByIndex.get(stream.index) || {};
        var codec = normalize(meta.codec_name || stream.codec_name || "");
        var lang = normalize((meta.tags && meta.tags.language) || "");
        var commentary = isCommentary(meta);
        var forced = meta.disposition && meta.disposition.forced ? 1 : 0;
        return {
            stream: stream,
            codec: codec,
            codecRank: getCodecRank(codec),
            lang: lang,
            langRank: getLanguageRank(lang),
            commentary: commentary ? 1 : 0,
            forced: forced,
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
        if (a.forced !== b.forced) {
            return b.forced - a.forced;
        }
        return a.originalIndex - b.originalIndex;
    });
    var reordered = [];
    var firstDefaultIndex = sortable.findIndex(function (item) { return item.commentary === 0; });
    if (firstDefaultIndex === -1) {
        firstDefaultIndex = 0;
    }
    var changed = false;
    sortable.forEach(function (item, idx) {
        var makeDefault = idx === firstDefaultIndex;
        var makeForced = item.forced === 1;
        var updatedOutputArgs = item.stream.outputArgs || [];
        updatedOutputArgs = updateDisposition(updatedOutputArgs, makeDefault, makeForced);
        if (idx !== item.originalIndex) {
            changed = true;
        }
        if ((item.stream.outputArgs || []).join("|") !== updatedOutputArgs.join("|")) {
            changed = true;
        }
        reordered.push(Object.assign({}, item.stream, {
            outputArgs: updatedOutputArgs,
        }));
    });
    var outputStreams = reordered.concat(otherStreams);
    if (changed) {
        args.variables.ffmpegCommand.streams = outputStreams;
        args.variables.ffmpegCommand.shouldProcess = true;
        args.variables.ffmpegCommand.init = true;
    }
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
