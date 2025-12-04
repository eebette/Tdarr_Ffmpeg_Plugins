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
    var height = stream.height || (stream.tags && stream.tags.height) || 0;
    if (height >= 2160) {
        return "4K";
    }
    if (height >= 1440) {
        return "1440p";
    }
    if (height >= 1080) {
        return "1080p";
    }
    if (height >= 720) {
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
    var isDv = codecName.startsWith("dvh")
        || codecName.startsWith("dv")
        || codecName.includes("dovi")
        || /dolby\s*vision/i.test(profile);
    var hdrTransfer = transfer === "smpte2084";
    var hlg = transfer === "arib-std-b67" || /hlg/.test(transfer);
    if (isDv) {
        var profileMatch = profile.match(/(\d+(\.\d+)?)/);
        var profileText = profileMatch ? "Profile ".concat(profileMatch[1]) : "Profile";
        var base = hdrTransfer ? "HDR10" : "HDR";
        return "Dolby Vision ".concat(profileText, " (").concat(base, ")");
    }
    if (hdrTransfer) {
        return "HDR10";
    }
    if (hlg) {
        return "HDR";
    }
    return "SDR";
};
var buildTitle = function (stream) {
    var resolution = formatResolution(stream);
    var codec = (stream.codec_name || stream.codec_tag_string || "video").toString().toUpperCase();
    var hdr = detectHdrLabel(stream);
    return "".concat(resolution, " ").concat(codec, " ").concat(hdr);
};
var setMetadataArg = function (outputArgs, title) {
    var cleaned = [];
    for (var i = 0; i < outputArgs.length; i += 1) {
        var arg = outputArgs[i];
        if (/^-metadata:s:v/.test(arg)) {
            i += 1;
            continue;
        }
        cleaned.push(arg);
    }
    cleaned.push("-metadata:s:v:{outputTypeIndex}");
    cleaned.push("title=".concat(title));
    return cleaned;
};
var plugin = function (args) {
    var lib = require("../../../../../methods/lib")();
    var inputs = lib.loadDefaultValues(normalizeInputs(args.inputs), details);
    args.inputs = inputs;
    flowUtils.checkFfmpegCommandInit(args);
    var streams = args.variables.ffmpegCommand.streams || [];
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
        var updatedArgs = setMetadataArg(stream.outputArgs || [], title);
        if ((stream.outputArgs || []).join("|") !== updatedArgs.join("|")) {
            changed = true;
        }
        return Object.assign({}, stream, {
            outputArgs: updatedArgs,
        });
    });
    if (changed) {
        args.variables.ffmpegCommand.streams = newStreams;
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
