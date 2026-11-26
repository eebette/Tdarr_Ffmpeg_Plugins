# Tests

Run inside the Tdarr image, so node, `tdarr-ffmpeg` and `ffprobe` are the production builds:

```bash
tests/run.sh                    # everything
tests/run.sh unit pipeline      # no media
tests/run.sh combos             # plugin order robustness
tests/run.sh integration -- --test-name-pattern 'cover'
KEEP_WORK=/tmp/tdarr-tests tests/run.sh integration   # keep generated media and outputs
```

Needs docker, curl, tar. First run downloads upstream
[Tdarr_Plugins](https://github.com/HaveAGitGat/Tdarr_Plugins) at the commit in `UPSTREAM_COMMIT`
into `tests/.cache/`. Inside the container this repo's plugins are laid over the upstream tree,
the same way `install_flow_plugins.sh` installs them, so plugins resolve `FlowHelpers`,
`methods/lib` and the community plugins exactly as on a server. The repo is mounted read-only.

## Layers

| Layer | What runs | Media | Catches |
|---|---|---|---|
| `unit/` | one plugin, handmade stream lists (`lib/probes.js`) | none | plugin decisions |
| `pipeline/` | whole chains from the exported flows, command recorded and resolved by `lib/cmd.js` | none | index drift between plugins, on every layout in the library |
| `integration/` | whole chains, real `tdarr-ffmpeg`, output probed | generated per test (`lib/media.js`) | what ffmpeg really does with the command |
| `combos/` | every plugin alone, every ordered pair, hand-picked and seeded random longer sequences, each on every layout in `lib/combo.js` | generated once per layout | plugins that only work in one position |

Chains come from `fixtures/flows/*.json`: each `Begin Command` to `Execute` run in the exported
flow, in flow order, with the flow's own inputs. Tests therefore follow the production wiring,
community plugins included.

`lib/cmd.js` is a model of ffmpeg's `-map` / `-c` stream specifier rules. It is only trusted
because `integration/cmd-model.test.js` compares it with real ffmpeg on a matrix of commands.
Extend that matrix whenever the model learns a new rule.

## Combination tests

Goal: any plugin, any position, stream references still right. No per-plugin expectations are
written down. Each `ffmpegCommand` stream entry carries the input stream it stands for
(`index`, set by Begin Command) and its own arguments, so the surviving entries in order are
what the plugins *intend* to come out. Checks per sequence and layout:

- **reference**: after each plugin, the command Execute would issue at that point must resolve
  (`lib/cmd.js`) to exactly that intent. Names the first plugin that breaks it.
- **frame**: a plugin may only touch the stream kinds its `frame` in `lib/combo.js` allows
  (an audio filter may remove audio, nothing else).
- **ffmpeg / output**: the final command runs for real and the written file must match intent,
  stream by stream (`TESTID`), codec and default/forced flags included.

Each suite ends with a summary; `pairs` prints a first-plugin by second-plugin table.
Cover-art layouts are counted on their own line: Execute carries cover art by extract and
`-attach`, a separate code path worth watching.
Add a plugin: one line in `STEPS`. Add a container shape: one entry in `LAYOUTS`.

## Reading failures

Integration expectations are token lists, one token per stream in file order:

```
v:<codec>                        video
a:<codec>:<lang>:<channels>:<id> audio, trailing * = default
s:<codec>:<lang>:<id>            subtitle, * = default, ! = forced
t:<filename>                     attachment
pic:<filename>:<codec>           cover art (attached picture)
```

`<id>` is a `TESTID` tag written at build time, so a stream can be followed through remuxes.

The library sweep reports problem classes with the number of library files behind each.

## Fixtures

- `fixtures/flows/` from `tools/export_flows.py` (run against the Tdarr API). It redacts
  secret-looking inputs and URL hosts; still read the diff before committing.
- `fixtures/probes/library-layouts.json.gz` from `tools/harvest_probes.py | gzip -9n` (read-only
  `ffprobe` sweep). One entry per distinct stream layout with a file count. No paths or file
  names; title words and attachment names are replaced by placeholders. Inspect with
  `zcat ... | python3 -m json.tool | less`.

Refresh both after changing a flow in Tdarr or when the library has grown.
When the server updates its plugins, copy the new commit from
`<tdarr>/server/Tdarr/Plugins/gotCommit.txt` into `UPSTREAM_COMMIT`.

## Limits

- Dolby Vision cannot be synthesized. DV layouts are covered at pipeline level only, and the
  Dolby Vision plugins (other repo) are not exercised.
- No PGS subtitles in generated media: ffmpeg has no PGS encoder.
- TrueHD and DTS encoders stop at 5.1, so 7.1 is covered by unit and pipeline tests only.
- Flow routing between chains (the `Check Dolby Vision` nodes) is approximated in the sweep by
  the DOVI side-data flag.
