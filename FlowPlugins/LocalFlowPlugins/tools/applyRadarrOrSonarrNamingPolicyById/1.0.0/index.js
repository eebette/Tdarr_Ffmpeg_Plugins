"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

var fileMoveOrCopy = require("../../../../FlowHelpers/1.0.0/fileMoveOrCopy");
var fileUtils = require("../../../../FlowHelpers/1.0.0/fileUtils");
var doMoveOrCopy = fileMoveOrCopy.default || fileMoveOrCopy;

/**
 * Apply Radarr or Sonarr naming policy (By ID)
 *
 * Like the community applyRadarrOrSonarrNamingPolicy, but resolves the library
 * item from the [tmdbid-N]/[tvdbid-N] tag in the filename first via an exact
 * library query — the community plugin's imdb/parse lookups fail
 * deterministically for series whose canonical title carries a year
 * disambiguator (e.g. "Avatar: The Last Airbender (2024)"). See the sibling
 * notifyRadarrOrSonarrById plugin for the same lookup, same reason.
 */

var details = function () { return ({
    name: 'Apply Radarr or Sonarr naming policy (By ID)',
    description: 'Apply Radarr or Sonarr naming policy to a file. Resolves the item by the '
        + '[tmdbid]/[tvdbid] tag in the filename first, falling back to imdb and parse lookups. '
        + 'This plugin should be called after the original file has been replaced and Radarr or '
        + 'Sonarr has been notified.',
    style: {
        borderColor: 'green',
    },
    tags: '',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faPenToSquare',
    inputs: [
        {
            label: 'Arr',
            name: 'arr',
            type: 'string',
            defaultValue: 'radarr',
            inputUI: {
                type: 'dropdown',
                options: ['radarr', 'sonarr'],
            },
            tooltip: 'Specify which arr to use',
        },
        {
            label: 'Arr API Key',
            name: 'arr_api_key',
            type: 'string',
            defaultValue: '',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Input your arr api key here',
        },
        {
            label: 'Arr Host',
            name: 'arr_host',
            type: 'string',
            defaultValue: 'http://192.168.1.1:7878',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Input your arr host here.'
                + '\\nExample:\\n'
                + 'http://192.168.1.1:7878\\n'
                + 'http://192.168.1.1:8989\\n'
                + 'https://radarr.domain.com\\n'
                + 'https://sonarr.domain.com\\n',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'Radarr or Sonarr notified',
        },
        {
            number: 2,
            tooltip: 'Radarr or Sonarr do not know this file',
        },
    ],
}); };
exports.details = details;

var parseSeasonEpisode = function (fileName) {
    var se = (/\bS(\d{1,3})E(\d{1,4})\b/i.exec(fileName)) || null;
    return {
        seasonNumber: se ? Number(se[1]) : -1,
        episodeNumber: se ? Number(se[2]) : -1,
    };
};

var getFileInfoFromIdTag = async function (args, arrApp, fileName) {
    var fInfo = { id: '-1' };
    var tagMatch = arrApp.name === 'radarr'
        ? /\[tmdbid-(\d+)\]/i.exec(fileName)
        : /\[tvdbid-(\d+)\]/i.exec(fileName);
    if (!tagMatch) return fInfo;
    var dbId = tagMatch[1];
    var res = await args.deps.axios({
        method: 'get',
        url: "".concat(arrApp.host, "/api/v3/").concat(arrApp.name === 'radarr'
            ? "movie?tmdbId=".concat(dbId)
            : "series?tvdbId=".concat(dbId)),
        headers: arrApp.headers,
    });
    var id = (res.data && res.data[0] && res.data[0].id) !== undefined && res.data[0]
        ? String(res.data[0].id)
        : '-1';
    fInfo.id = id;
    if (arrApp.name === 'sonarr' && id !== '-1') {
        var se = parseSeasonEpisode(fileName);
        fInfo.seasonNumber = se.seasonNumber;
        fInfo.episodeNumber = se.episodeNumber;
    }
    args.jobLog("".concat(arrApp.content, " ").concat(fInfo.id !== '-1' ? "'".concat(fInfo.id, "' found") : 'not found')
        + " for ".concat(arrApp.name === 'radarr' ? 'tmdbId' : 'tvdbId', " '").concat(dbId, "'"));
    return fInfo;
};

var getFileInfoFromLookup = async function (args, arrApp, fileName) {
    var fInfo = { id: '-1' };
    var imdbMatch = /\b(tt|nm|co|ev|ch|ni)\d{7,10}\b/i.exec(fileName);
    var imdbId = imdbMatch ? imdbMatch[0] : '';
    if (imdbId !== '') {
        var lookupResponse = await args.deps.axios({
            method: 'get',
            url: "".concat(arrApp.host, "/api/v3/").concat(arrApp.name === 'radarr' ? 'movie' : 'series', "/lookup?term=imdb:").concat(imdbId),
            headers: arrApp.headers,
        });
        fInfo = arrApp.delegates.getFileInfoFromLookupResponse(lookupResponse, fileName);
        args.jobLog("".concat(arrApp.content, " ").concat(fInfo.id !== '-1' ? "'".concat(fInfo.id, "' found") : 'not found')
            + " for imdb '".concat(imdbId, "'"));
    }
    return fInfo;
};

var getFileInfoFromParse = async function (args, arrApp, fileName) {
    var parseResponse = await args.deps.axios({
        method: 'get',
        url: "".concat(arrApp.host, "/api/v3/parse?title=").concat(encodeURIComponent(fileUtils.getFileName(fileName))),
        headers: arrApp.headers,
    });
    var fInfo = arrApp.delegates.getFileInfoFromParseResponse(parseResponse);
    args.jobLog("".concat(arrApp.content, " ").concat(fInfo.id !== '-1' ? "'".concat(fInfo.id, "' found") : 'not found')
        + " for '".concat(fileUtils.getFileName(fileName), "'"));
    return fInfo;
};

var getFileInfo = async function (args, arrApp, fileName) {
    var fInfo = await getFileInfoFromIdTag(args, arrApp, fileName);
    if (fInfo.id !== '-1' && !(arrApp.name === 'sonarr' && (fInfo.seasonNumber === -1 || fInfo.episodeNumber === -1))) {
        return fInfo;
    }
    fInfo = await getFileInfoFromLookup(args, arrApp, fileName);
    if (fInfo.id !== '-1' && !(arrApp.name === 'sonarr' && (fInfo.seasonNumber === -1 || fInfo.episodeNumber === -1))) {
        return fInfo;
    }
    return getFileInfoFromParse(args, arrApp, fileName);
};

var plugin = async function (args) {
    var lib = require('../../../../../methods/lib')();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var newPath = '';
    var isSuccessful = false;
    var arr = String(args.inputs.arr);
    var arrHostRaw = String(args.inputs.arr_host).trim();
    var arrHost = arrHostRaw.endsWith('/') ? arrHostRaw.slice(0, -1) : arrHostRaw;
    var originalFileName = (args.originalLibraryFile && args.originalLibraryFile._id) || '';
    var currentFileName = (args.inputFileObj && args.inputFileObj._id) || '';
    var headers = {
        'Content-Type': 'application/json',
        'X-Api-Key': String(args.inputs.arr_api_key),
        Accept: 'application/json',
    };
    var arrApp = arr === 'radarr'
        ? {
            name: arr,
            host: arrHost,
            headers: headers,
            content: 'Movie',
            delegates: {
                getFileInfoFromLookupResponse: function (lookupResponse) {
                    var first = lookupResponse && lookupResponse.data && lookupResponse.data[0];
                    return { id: String((first && first.id) !== undefined && first ? first.id : -1) };
                },
                getFileInfoFromParseResponse: function (parseResponse) {
                    var m = parseResponse && parseResponse.data && parseResponse.data.movie;
                    return { id: String((m && m.id) !== undefined && m ? m.id : -1) };
                },
                buildPreviewRenameRequestUrl: function (fInfo) {
                    return "".concat(arrHost, "/api/v3/rename?movieId=").concat(fInfo.id);
                },
                getFileToRenameFromPreviewRenameResponse: function (previewRenameResponse) {
                    return previewRenameResponse.data && previewRenameResponse.data[0];
                },
            },
        }
        : {
            name: arr,
            host: arrHost,
            headers: headers,
            content: 'Serie',
            delegates: {
                getFileInfoFromLookupResponse: function (lookupResponse, fileName) {
                    var first = lookupResponse && lookupResponse.data && lookupResponse.data[0];
                    var fInfo = { id: String((first && first.id) !== undefined && first ? first.id : -1) };
                    if (fInfo.id !== '-1') {
                        var se = parseSeasonEpisode(fileName);
                        fInfo.seasonNumber = se.seasonNumber;
                        fInfo.episodeNumber = se.episodeNumber;
                    }
                    return fInfo;
                },
                getFileInfoFromParseResponse: function (parseResponse) {
                    var d = (parseResponse && parseResponse.data) || {};
                    var epi = d.parsedEpisodeInfo || {};
                    return {
                        id: String((d.series && d.series.id) !== undefined && d.series ? d.series.id : -1),
                        seasonNumber: epi.seasonNumber !== undefined ? epi.seasonNumber : 1,
                        episodeNumber: (epi.episodeNumbers && epi.episodeNumbers[0]) !== undefined
                            ? epi.episodeNumbers[0] : 1,
                    };
                },
                buildPreviewRenameRequestUrl: function (fInfo) {
                    return "".concat(arrHost, "/api/v3/rename?seriesId=").concat(fInfo.id, "&seasonNumber=").concat(fInfo.seasonNumber);
                },
                getFileToRenameFromPreviewRenameResponse: function (previewRenameResponse, fInfo) {
                    var fileToRename = (previewRenameResponse.data || []).find(function (episodeFile) {
                        return (episodeFile.episodeNumbers || [])[0] === fInfo.episodeNumber;
                    });
                    if (!fileToRename) return undefined;
                    return Object.assign({}, fileToRename, {
                        newPath: fileToRename.newPath.split(/[\\/]/).pop() || fileToRename.newPath,
                    });
                },
            },
        };

    args.jobLog('Going to apply new name');
    args.jobLog("Renaming ".concat(arrApp.name, "..."));

    var fInfo = await getFileInfo(args, arrApp, originalFileName);
    if (fInfo.id === '-1' && currentFileName !== originalFileName) {
        fInfo = await getFileInfo(args, arrApp, currentFileName);
    }

    if (fInfo.id !== '-1') {
        var previewRenameRequestResult = await args.deps.axios({
            method: 'get',
            url: arrApp.delegates.buildPreviewRenameRequestUrl(fInfo),
            headers: headers,
        });
        var fileToRename = arrApp.delegates
            .getFileToRenameFromPreviewRenameResponse(previewRenameRequestResult, fInfo);
        if (fileToRename !== undefined) {
            newPath = "".concat(fileUtils.getFileAbsoluteDir(currentFileName), "/")
                .concat(fileUtils.getFileName(fileToRename.newPath), ".")
                .concat(fileUtils.getContainer(fileToRename.newPath));
            isSuccessful = await doMoveOrCopy({
                operation: 'move',
                sourcePath: currentFileName,
                destinationPath: newPath,
                args: args,
                requireSourceDeletion: true,
            });
        } else {
            isSuccessful = true;
            args.jobLog('✔ No rename necessary.');
        }
    }

    return {
        outputFileObj: isSuccessful && newPath !== ''
            ? Object.assign({}, args.inputFileObj, { _id: newPath })
            : args.inputFileObj,
        outputNumber: isSuccessful ? 1 : 2,
        variables: args.variables,
    };
};
exports.plugin = plugin;
