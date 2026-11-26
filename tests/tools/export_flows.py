#!/usr/bin/env python3
"""Export Tdarr flows as scrubbed test fixtures.

Usage (host that reaches Tdarr server API):
    export_flows.py --url http://tdarr:8265 --flow "Main (v2) - Movies" --flow "Main (v2) - Series" > flows.json

Stdout: JSON object {slug: flow}. Split into tests/fixtures/flows/<slug>.json with --out DIR.
Scrub: secret-looking inputs -> "REDACTED", non-loopback URL hosts -> redacted.invalid.
Review diff before commit anyway: scrub = pattern match, not proof.
"""
import argparse
import json
import os
import re
import sys
import urllib.request

SECRET_KEY = re.compile(r"key|token|secret|passw|auth|header|cookie|credential", re.I)
URL_HOST = re.compile(r"(https?://)([^/\s\"']+)")
LOOPBACK = re.compile(r"^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$")
PRIVATE_IP = re.compile(r"\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b")


def scrub_value(key, value):
    """:return: scrubbed copy of one inputsDB value"""
    if not isinstance(value, str):
        return value
    if SECRET_KEY.search(key) and value.strip():
        return "REDACTED"
    value = URL_HOST.sub(lambda m: m.group(0) if LOOPBACK.match(m.group(2)) else m.group(1) + "redacted.invalid", value)
    return PRIVATE_IP.sub(lambda m: m.group(0) if m.group(0).startswith("127.") else "0.0.0.0", value)


def scrub_flow(flow):
    """:return: flow with plugin inputs scrubbed, UI-only fields dropped"""
    out = {"_id": flow["_id"], "name": flow["name"], "flowPlugins": [], "flowEdges": []}
    for plugin in flow["flowPlugins"]:
        plugin = dict(plugin)
        if plugin.get("inputsDB"):
            plugin["inputsDB"] = {k: scrub_value(k, v) for k, v in plugin["inputsDB"].items()}
        out["flowPlugins"].append(plugin)
    for edge in flow["flowEdges"]:
        out["flowEdges"].append({k: edge[k] for k in ("source", "sourceHandle", "target", "id") if k in edge})
    return out


def slug(name):
    """:return: file-name-safe flow name"""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True, help="Tdarr server base URL")
    parser.add_argument("--flow", action="append", required=True, help="flow name, repeatable")
    parser.add_argument("--out", help="write <slug>.json files here instead of stdout")
    opts = parser.parse_args()

    req = urllib.request.Request(
        opts.url.rstrip("/") + "/api/v2/cruddb",
        json.dumps({"data": {"collection": "FlowsJSONDB", "mode": "getAll"}}).encode(),
        {"content-type": "application/json"},
    )
    flows = {f["name"]: f for f in json.load(urllib.request.urlopen(req, timeout=60))}
    missing = [n for n in opts.flow if n not in flows]
    if missing:
        sys.exit("flow not found: %s (have: %s)" % (missing, sorted(flows)))
    result = {slug(n): scrub_flow(flows[n]) for n in opts.flow}
    if opts.out:
        for name, flow in result.items():
            with open(os.path.join(opts.out, name + ".json"), "w") as handle:
                json.dump(flow, handle, indent=1, sort_keys=True)
                handle.write("\n")
    else:
        json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
