"use strict";
// Execute = only place that turns stream state into ffmpeg arguments.
//
// Contract with every other ffmpegCommand plugin: edit variables.ffmpegCommand.streams
// and nothing else. Per stream entry:
//   index       input stream it stands for (set by Begin Command); never change
//   removed     true = drop from output (deleting entry from array works too)
//   mapArgs     ["-map", "<input>:<stream>"]; absolute index from Begin Command
//   outputArgs  options for this stream only. Use {outputIndex} / {outputTypeIndex}
//               placeholders; codec option may be written as plain "-c"
//   inputArgs   options placed before -i
// Array order = output order. Cover art (attached pic) kept in an mkv is not mapped:
// ffmpeg would write it as a plain video track, so Execute extracts and re-attaches it.
// Plugins never write maps into overall arguments and never
// set shouldProcess = false: a plugin with nothing to do must not cancel earlier ones.
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var fs = require("fs");
var path = require("path");
var cliUtils_1 = require("../../../../FlowHelpers/1.0.0/cliUtils");
var fileUtils_1 = require("../../../../FlowHelpers/1.0.0/fileUtils");
var flowUtils_1 = require("../../../../FlowHelpers/1.0.0/interfaces/flowUtils");
var details = function () { return ({
    name: 'Execute',
    description: 'Execute the created FFmpeg command, ensuring filter args are ordered before mapping args',
    style: {
        borderColor: 'green',
    },
    tags: 'video',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: 2,
    icon: 'faPlay',
    inputs: [],
    outputs: [
        {
            number: 1,
            tooltip: 'Continue to next plugin',
        },
    ],
}); };
exports.details = details;
var normalizeInputs = function (inputs) {
    if (Array.isArray(inputs)) {
        return inputs;
    }
    if (inputs && typeof inputs === "object") {
        return Object.keys(inputs).map(function (key) { return ({ name: key, value: inputs[key] }); });
    }
    return [];
};
var isFilterArgument = function (arg) { return arg === '-vf' || arg.startsWith('-vf:') || arg.startsWith('-filter:') || arg === '-filter_complex' || arg.startsWith('-filter_complex:'); };
var isMetadataArgument = function (arg) { return arg === '-metadata' || arg.startsWith('-metadata:'); };
var isCodecFlag = function (arg) { return /^-(?:c|codec)(?::.*)?$/i.test(arg); };
var getProbeStreams = function (fileObj) {
    var ffprobe = (fileObj && (fileObj.ffprobeData
        || fileObj.ffProbeData
        || (fileObj.meta && fileObj.meta.ffProbeData))) || { streams: [] };
    return ffprobe.streams || [];
};
// Stream type as ffmpeg counts it. Begin Command relabels attached pics (cover art)
// as "attachment"; ffmpeg still treats them as video ("v"), never as "t".
var ffmpegTypeOf = function (stream) {
    if (Number((stream.disposition || {}).attached_pic) === 1) {
        return 'v';
    }
    return { video: 'v', audio: 'a', subtitle: 's', data: 'd', attachment: 't' }[stream.codec_type] || '';
};
var isAttachedPic = function (stream) { return Number((stream.disposition || {}).attached_pic) === 1; };
var PIC_TYPES = {
    png: { ext: 'png', mime: 'image/png' },
    mjpeg: { ext: 'jpg', mime: 'image/jpeg' },
    bmp: { ext: 'bmp', mime: 'image/bmp' },
    gif: { ext: 'gif', mime: 'image/gif' },
    webp: { ext: 'webp', mime: 'image/webp' },
};
/**
 * Cover art entries Execute must carry by extract + "-attach" instead of "-map".
 *
 * ffmpeg cannot stream-copy an attached pic into matroska as attachment (lands as
 * video track; with an encoder running and fonts mapped first the muxer even aborts:
 * "Received a packet for an attachment stream"). Only main-input pics of known image
 * type qualify; anything else stays mapped as before.
 *
 * :return: [{stream, file name, mime}]
 */
var planCoverArt = function (streams, probeStreams, container) {
    if (container !== 'mkv') {
        return [];
    }
    var plan = [];
    streams.forEach(function (stream) {
        var mapTarget = (stream.mapArgs || [])[1];
        var fromMainInput = typeof stream.index === 'number' && (mapTarget === undefined || mapTarget === '0:'.concat(stream.index));
        if (!isAttachedPic(stream) || !fromMainInput) {
            return;
        }
        var meta = probeStreams[stream.index] || stream;
        var type = PIC_TYPES[String(stream.codec_name || meta.codec_name || '').toLowerCase()];
        if (!type) {
            return;
        }
        var tags = stream.tags || meta.tags || {};
        var name = path.basename(String(tags.filename || tags.FILENAME || '')) || 'cover.'.concat(type.ext);
        plan.push({ stream: stream, name: name, mime: tags.mimetype || tags.MIMETYPE || type.mime });
    });
    return plan;
};
/**
 * Maps + per-stream options for kept streams, in order.
 *
 * Codec option always addressed by absolute output index ("-c:3"): exact for
 * every stream type, no per-type counting to drift.
 */
var buildOutputArgsFromStreams = function (streams) {
    var typeCounters = {};
    return streams.reduce(function (acc, stream, outputIndex) {
        var type = ffmpegTypeOf(stream);
        var outputTypeIndex = typeCounters[type] || 0;
        typeCounters[type] = outputTypeIndex + 1;
        var mapArgs = (stream.mapArgs && stream.mapArgs.length > 0)
            ? stream.mapArgs
            : ['-map', '0:'.concat(stream.index)];
        var ownArgs = stream.outputArgs || [];
        var outputArgs = ownArgs.map(function (arg) {
            if (isCodecFlag(arg)) {
                return '-c:'.concat(outputIndex);
            }
            return arg
                .split('{outputIndex}').join(String(outputIndex))
                .split('{outputTypeIndex}').join(String(outputTypeIndex));
        });
        if (!ownArgs.some(isCodecFlag)) {
            outputArgs = ['-c:'.concat(outputIndex), 'copy'].concat(outputArgs);
        }
        acc.push.apply(acc, mapArgs);
        acc.push.apply(acc, outputArgs);
        return acc;
    }, []);
};
// Kept entries still exactly the input's streams, in input order?
var isInputLayout = function (streams, probeStreams) {
    return streams.length === probeStreams.length && streams.every(function (stream, pos) {
        var probeIndex = typeof probeStreams[pos].index === 'number' ? probeStreams[pos].index : pos;
        return stream.index === probeIndex;
    });
};
var moveArgsBeforeMaps = function (args, isMovable, afterFilters) {
    var moved = [];
    var rest = [];
    for (var i = 0; i < args.length; i += 1) {
        if (isMovable(args[i])) {
            moved.push(args[i]);
            if (i + 1 < args.length) {
                moved.push(args[i + 1]);
                i += 1;
            }
        }
        else {
            rest.push(args[i]);
        }
    }
    var firstMapIndex = rest.indexOf('-map');
    if (moved.length === 0 || firstMapIndex === -1) {
        return args.slice();
    }
    var insertIndex = firstMapIndex;
    if (afterFilters) {
        // metadata goes after any filter args already sitting before maps
        for (var j = 0; j < firstMapIndex; j += 1) {
            if (isFilterArgument(rest[j])) {
                insertIndex = Math.min(j + 2, firstMapIndex);
            }
        }
    }
    rest.splice.apply(rest, [insertIndex, 0].concat(moved));
    return rest;
};
var hasDolbyVisionStream = function (fileObj) {
    return getProbeStreams(fileObj).some(function (s) {
        if (!s || s.codec_type !== 'video') {
            return false;
        }
        var name = (s.codec_name || '').toString().toLowerCase();
        var tags = s.tags || {};
        var handler = (tags.handler_name || '').toString().toLowerCase();
        var sideData = Array.isArray(s.side_data_list) ? s.side_data_list : [];
        var sideHasDv = sideData.some(function (entry) {
            var t = (entry.side_data_type || '').toString().toLowerCase();
            return t.includes('dovi');
        });
        return name.startsWith('dv')
            || handler.includes('dolby vision')
            || handler.includes('dovi')
            || sideHasDv;
    });
};
var insertDolbyVisionArgs = function (args) {
    // For Dolby Vision streams, we only need -strict unofficial when copying.
    // Do NOT use bitstream filters (hevc_mp4toannexb) for MP4-to-MP4 copying
    // as they strip the dvcC box (Dolby Vision Configuration).
    // Do NOT change codec tags - let ffmpeg preserve the original (hev1/dvhe/etc).
    return args.includes('-strict') ? args.slice() : args.concat(['-strict', 'unofficial']);
};
var unchanged = function (args) {
    args.jobLog('No need to process file, already as required');
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
// eslint-disable-next-line @typescript-eslint/no-unused-vars
var plugin = async function (args) {
    var lib = require('../../../../../methods/lib')();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
    args.inputs = lib.loadDefaultValues(normalizeInputs(args.inputs), details);
    (0, flowUtils_1.checkFfmpegCommandInit)(args);
    var command = args.variables.ffmpegCommand;
    var probeStreams = getProbeStreams(args.inputFileObj);
    var allStreams = command.streams || [];
    var streams = allStreams.filter(function (stream) { return !stream.removed; });
    if (streams.length === 0) {
        args.jobLog('No streams mapped for new file');
        throw new Error('No streams mapped for new file');
    }
    var additionalInputs = command.additionalInputs || [];
    var overallInputArgs = command.overallInputArguments || [];
    // Upstream plugins spell it "overallOuputArguments"; accept both, once.
    var overallOutputArgs = (command.overallOutputArguments || []).slice();
    var upstreamOutputArgs = command.overallOuputArguments || [];
    if (upstreamOutputArgs.join('\n') !== overallOutputArgs.join('\n')) {
        overallOutputArgs = overallOutputArgs.concat(upstreamOutputArgs);
    }
    // Work to do = anything differs from a plain copy of the input. Decided here from
    // state, so no plugin can switch off another plugin's change.
    var shouldProcess = command.shouldProcess === true
        || !isInputLayout(streams, probeStreams)
        || streams.some(function (stream) { return (stream.inputArgs || []).length > 0 || (stream.outputArgs || []).length > 0; })
        || additionalInputs.length > 0
        || overallInputArgs.length > 0
        || overallOutputArgs.length > 0;
    if (!shouldProcess) {
        return unchanged(args);
    }
    var inputExt = (args.inputFileObj.container
        || ((args.inputFileObj._id || '').split('.').pop())
        || 'mkv').toLowerCase();
    // Respect the container of the current input if no explicit override was provided.
    if (!command.container) {
        command.container = inputExt;
    }
    var targetContainer = String(command.container).toLowerCase();

    var cliArgs = ['-y'];
    cliArgs.push.apply(cliArgs, overallInputArgs);
    streams.forEach(function (stream) { cliArgs.push.apply(cliArgs, stream.inputArgs || []); });
    cliArgs.push('-i', args.inputFileObj._id);
    additionalInputs.forEach(function (input) { cliArgs.push('-i', input); });

    var pluginWorkDir = (0, fileUtils_1.getPluginWorkDir)(args);
    var coverArt = planCoverArt(streams, probeStreams, targetContainer);
    var coverStreams = coverArt.map(function (item) { return item.stream; });
    var mappedStreams = streams.filter(function (stream) { return coverStreams.indexOf(stream) === -1; });
    if (mappedStreams.length === 0) {
        args.jobLog('No streams mapped for new file');
        throw new Error('No streams mapped for new file');
    }
    var outputArgs = buildOutputArgsFromStreams(mappedStreams);
    // "-attach" streams land after all mapped ones: attachment index continues from mapped fonts.
    var attachmentIndex = mappedStreams.filter(function (stream) { return ffmpegTypeOf(stream) === 't'; }).length;
    for (var c = 0; c < coverArt.length; c += 1) {
        var item = coverArt[c];
        var coverDir = path.join(pluginWorkDir, 'cover-'.concat(c));
        fs.mkdirSync(coverDir, { recursive: true });
        item.file = path.join(coverDir, item.name);
        var extractArgs = ['-y', '-i', args.inputFileObj._id, '-map', '0:'.concat(item.stream.index), '-c', 'copy', '-frames:v', '1', '-update', '1', item.file];
        args.jobLog('Extracting cover art: '.concat(extractArgs.join(' ')));
        // eslint-disable-next-line no-await-in-loop
        var extracted = await new cliUtils_1.CLI({
            cli: args.ffmpegPath,
            spawnArgs: extractArgs,
            spawnOpts: {},
            jobLog: args.jobLog,
            outputFilePath: item.file,
            inputFileObj: args.inputFileObj,
            logFullCliOutput: args.logFullCliOutput,
            updateWorker: args.updateWorker,
            args: args,
        }).runCli();
        if (extracted.cliExitCode !== 0) {
            args.jobLog('Extracting cover art failed');
            throw new Error('FFmpeg failed');
        }
        var selector = '-metadata:s:t:'.concat(attachmentIndex + c);
        outputArgs.push('-attach', item.file, selector, 'mimetype='.concat(item.mime), selector, 'filename='.concat(item.name));
    }
    outputArgs = outputArgs.concat(overallOutputArgs);
    var keptIndexes = new Set(streams.map(function (stream) { return stream.index; }));
    var droppedDataStream = probeStreams.some(function (s, pos) {
        return s.codec_type === 'data' && !keptIndexes.has(typeof s.index === 'number' ? s.index : pos);
    });
    if (droppedDataStream) {
        outputArgs.push('-dn');
        if (targetContainer === 'mp4') {
            // Strip chapter/stream metadata for data tracks when explicitly removed.
            outputArgs.push('-map_metadata:c', '-1');
        }
    }
    if (hasDolbyVisionStream(args.inputFileObj)) {
        outputArgs = insertDolbyVisionArgs(outputArgs);
    }
    cliArgs.push.apply(cliArgs, outputArgs);
    cliArgs = moveArgsBeforeMaps(cliArgs, isFilterArgument, false);
    cliArgs = moveArgsBeforeMaps(cliArgs, isMetadataArgument, true);

    var outputFilePath = "".concat(pluginWorkDir, "/").concat((0, fileUtils_1.getFileName)(args.inputFileObj._id))
        + ".".concat(command.container);
    cliArgs.push(outputFilePath);
    var spawnArgs = cliArgs.map(function (row) { return row.trim(); }).filter(function (row) { return row !== ''; });
    args.jobLog('Processing file');
    args.jobLog(JSON.stringify({
        spawnArgs: spawnArgs,
        outputFilePath: outputFilePath,
    }));
    args.updateWorker({
        CLIType: args.ffmpegPath,
        preset: spawnArgs.join(' '),
    });
    var cli = new cliUtils_1.CLI({
        cli: args.ffmpegPath,
        spawnArgs: spawnArgs,
        spawnOpts: {},
        jobLog: args.jobLog,
        outputFilePath: outputFilePath,
        inputFileObj: args.inputFileObj,
        logFullCliOutput: args.logFullCliOutput,
        updateWorker: args.updateWorker,
        args: args,
    });
    var res = await cli.runCli();
    if (res.cliExitCode !== 0) {
        args.jobLog('Running FFmpeg failed');
        throw new Error('FFmpeg failed');
    }
    args.logOutcome('tSuc');
    // eslint-disable-next-line no-param-reassign
    args.variables.ffmpegCommand.init = false;
    var tempFiles = (command.tempFiles || []).concat(coverArt.map(function (item) { return path.dirname(item.file); }));
    tempFiles.forEach(function (filePath) {
        try {
            if (fs.statSync(filePath).isDirectory()) {
                fs.rmSync(filePath, { recursive: true, force: true });
            }
            else {
                fs.unlinkSync(filePath);
            }
        }
        catch (err) {
            args.jobLog("Cleanup warning: ".concat(filePath, " ").concat(err.message));
        }
    });
    return {
        outputFileObj: {
            _id: outputFilePath,
        },
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
