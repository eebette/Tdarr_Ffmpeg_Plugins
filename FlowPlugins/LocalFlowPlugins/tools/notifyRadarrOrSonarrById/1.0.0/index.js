"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

/**
 * Notify Radarr or Sonarr (By ID)
 *
 * Like the community notifyRadarrOrSonarr, but resolves the library item by
 * the database id embedded in the filename first ([tmdbid-N] / [tvdbid-N])
 * via an exact library query. The community plugin's parse-based lookup
 * breaks on series whose canonical title carries a year disambiguator
 * (e.g. "Avatar: The Last Airbender (2024)"): with a [tvdbid-...] tag between
 * the year and SxxEyy, the arr parser lifts the year out of the title and the
 * cleaned title no longer matches the year-in-title record.
 *
 * Lookup order:
 *   1. [tmdbid-N]/[tvdbid-N] tag -> GET /movie?tmdbId=N | /series?tvdbId=N
 *   2. imdb id (ttNNNNNNN) in filename -> /lookup?term=imdb:ttN
 *   3. /parse?title=<file name> (community behaviour, last resort)
 */

var details = function () { return ({
    name: 'Notify Radarr or Sonarr (By ID)',
    description: 'Notify Radarr or Sonarr to refresh after file change. '
        + 'Resolves the item by the [tmdbid]/[tvdbid] tag in the filename first, '
        + 'falling back to imdb and parse lookups. '
        + 'Waits for the scan to complete before continuing.',
    style: {
        borderColor: 'green',
    },
    tags: '',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faBell',
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

var POLL_INTERVAL_SECONDS = 5;
var TIMEOUT_SECONDS = 120;

var getFileName = function (filePath) {
    var base = String(filePath).split('/').pop() || '';
    return base.replace(/\.[^.]+$/, '');
};

var waitForCommand = async function (args, arrApp, commandId) {
    var startTime = Date.now();
    args.jobLog("Waiting for command ".concat(commandId, " to complete (timeout: ").concat(TIMEOUT_SECONDS, "s)..."));
    while (true) {
        if (Date.now() - startTime >= TIMEOUT_SECONDS * 1000) {
            args.jobLog("Command ".concat(commandId, " timed out after ").concat(TIMEOUT_SECONDS, "s."));
            return false;
        }
        await new Promise(function (resolve) { setTimeout(resolve, POLL_INTERVAL_SECONDS * 1000); });
        var res = await args.deps.axios({
            method: 'get',
            url: "".concat(arrApp.host, "/api/v3/command/").concat(commandId),
            headers: arrApp.headers,
        });
        var status = res.data.status;
        args.jobLog("Command ".concat(commandId, " status: ").concat(status));
        if (status === 'completed') {
            return true;
        }
        if (status === 'failed' || status === 'aborted' || status === 'cancelled') {
            args.jobLog("Command ".concat(commandId, " ended with status: ").concat(status));
            return false;
        }
    }
};

var getId = async function (args, arrApp, fileName) {
    var id = -1;

    // 1. Exact library query from the [tmdbid-N]/[tvdbid-N] filename tag
    var tagMatch = arrApp.name === 'radarr'
        ? /\[tmdbid-(\d+)\]/i.exec(fileName)
        : /\[tvdbid-(\d+)\]/i.exec(fileName);
    if (tagMatch) {
        var dbId = tagMatch[1];
        var res = await args.deps.axios({
            method: 'get',
            url: "".concat(arrApp.host, "/api/v3/").concat(arrApp.name === 'radarr'
                ? "movie?tmdbId=".concat(dbId)
                : "series?tvdbId=".concat(dbId)),
            headers: arrApp.headers,
        });
        id = Number((res.data && res.data[0] && res.data[0].id) || -1);
        if (Number.isNaN(id)) id = -1;
        args.jobLog("".concat(arrApp.content, " ").concat(id !== -1 ? "'".concat(id, "' found") : 'not found', " for ")
            .concat(arrApp.name === 'radarr' ? 'tmdbId' : 'tvdbId', " '").concat(dbId, "'"));
        if (id !== -1) return id;
    }

    // 2. imdb id from filename
    var imdbMatch = /\b(tt|nm|co|ev|ch|ni)\d{7,10}\b/i.exec(fileName);
    var imdbId = imdbMatch ? imdbMatch[0] : '';
    if (imdbId !== '') {
        var lookup = await args.deps.axios({
            method: 'get',
            url: "".concat(arrApp.host, "/api/v3/").concat(arrApp.name === 'radarr' ? 'movie' : 'series', "/lookup?term=imdb:").concat(imdbId),
            headers: arrApp.headers,
        });
        id = Number((lookup.data && lookup.data[0] && lookup.data[0].id) || -1);
        if (Number.isNaN(id)) id = -1;
        args.jobLog("".concat(arrApp.content, " ").concat(id !== -1 ? "'".concat(id, "' found") : 'not found', " for imdb '").concat(imdbId, "'"));
        if (id !== -1) return id;
    }

    // 3. Parse fallback (community behaviour)
    var parseRes = await args.deps.axios({
        method: 'get',
        url: "".concat(arrApp.host, "/api/v3/parse?title=").concat(encodeURIComponent(getFileName(fileName))),
        headers: arrApp.headers,
    });
    id = arrApp.delegates.getIdFromParseResponse(parseRes);
    args.jobLog("".concat(arrApp.content, " ").concat(id !== -1 ? "'".concat(id, "' found") : 'not found', " for '").concat(getFileName(fileName), "'"));
    return id;
};

var plugin = async function (args) {
    var lib = require('../../../../../methods/lib')();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var refreshed = false;
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
                getIdFromParseResponse: function (parseResponse) {
                    var m = parseResponse && parseResponse.data && parseResponse.data.movie;
                    return Number((m && m.id) || -1) || -1;
                },
                buildRefreshRequestData: function (id) { return JSON.stringify({ name: 'RefreshMovie', movieIds: [id] }); },
            },
        }
        : {
            name: arr,
            host: arrHost,
            headers: headers,
            content: 'Serie',
            delegates: {
                getIdFromParseResponse: function (parseResponse) {
                    var s = parseResponse && parseResponse.data && parseResponse.data.series;
                    return Number((s && s.id) || -1) || -1;
                },
                buildRefreshRequestData: function (id) { return JSON.stringify({ name: 'RefreshSeries', seriesId: id }); },
            },
        };

    args.jobLog('Going to force scan');
    args.jobLog("Refreshing ".concat(arrApp.name, "..."));

    var id = await getId(args, arrApp, originalFileName);
    if (id === -1 && currentFileName !== originalFileName) {
        id = await getId(args, arrApp, currentFileName);
    }

    if (id !== -1) {
        var commandResponse = await args.deps.axios({
            method: 'post',
            url: "".concat(arrApp.host, "/api/v3/command"),
            headers: headers,
            data: arrApp.delegates.buildRefreshRequestData(id),
        });
        var commandId = commandResponse.data.id;
        args.jobLog("".concat(arrApp.content, " '").concat(id, "' refresh queued in ").concat(arrApp.name, " (command ").concat(commandId, ")."));
        var completed = await waitForCommand(args, arrApp, commandId);
        if (completed) {
            refreshed = true;
            args.jobLog("✔ ".concat(arrApp.content, " '").concat(id, "' scan completed in ").concat(arrApp.name, "."));
        } else {
            args.jobLog("⚠ ".concat(arrApp.content, " '").concat(id, "' scan did not complete within timeout."));
        }
    }

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: refreshed ? 1 : 2,
        variables: args.variables,
    };
};
exports.plugin = plugin;
