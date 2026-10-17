#!/usr/bin/env python3
"""Manage App Store version records via the App Store Connect API.

Usage:
  asc_delete_version.py --bundle-id Com.censorly.extension --list
  asc_delete_version.py --bundle-id X --version 1.1 --platform MAC_OS            # delete
  asc_delete_version.py --bundle-id X --version 1.1 --platform MAC_OS --rename-to 6.3
  ... same with --dry-run to only show what would happen

Apple restrictions (observed in the field):
  - Only a platform's first version record can be deleted.
  - No version record can be deleted once any build has been uploaded for that
    platform. When deletion is blocked, --rename-to recycles the stray record
    into the next real version instead.

Environment:
  ASC_KEY_ID        App Store Connect API key ID
  ASC_ISSUER_ID     App Store Connect issuer ID
  ASC_KEY_PATH      Path to the .p8 private key
"""
import argparse
import json
import os
import subprocess
import sys
import time

try:
    import jwt
except ImportError:
    print("pyjwt not installed: python3 -m pip install 'pyjwt[crypto]'", file=sys.stderr)
    sys.exit(2)

API_ROOT = "https://api.appstoreconnect.apple.com"
EDITABLE_STATES = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED",
                   "READY_FOR_REVIEW", "WAITING_FOR_REVIEW"}


def make_api():
    key_id = os.environ["ASC_KEY_ID"]
    issuer = os.environ["ASC_ISSUER_ID"]
    with open(os.environ["ASC_KEY_PATH"]) as f:
        key = f.read()

    def token():
        now = int(time.time())
        return jwt.encode({"iss": issuer, "iat": now, "exp": now + 600,
                           "aud": "appstoreconnect-v1"}, key,
                          algorithm="ES256", headers={"kid": key_id})

    def api(path, method="GET", data=None):
        body = json.dumps(data) if data else None
        r = subprocess.run(
            ["curl", "-sS", "-g", "-w", "\n%{http_code}", "-X", method,
             "-H", "Authorization: Bearer " + token(),
             "-H", "Content-Type: application/json"] +
            (["-d", body] if body else []) +
            [API_ROOT + path], capture_output=True, text=True)
        out, _, code = r.stdout.rpartition("\n")
        if not code.strip().isdigit():
            print("curl failed for", path, r.stderr[:400], file=sys.stderr)
            sys.exit(2)
        try:
            payload = json.loads(out) if out.strip() else {}
        except json.JSONDecodeError:
            payload = out
        return int(code), payload

    return api


def find_app(api, bundle_id):
    code, data = api(f"/v1/apps?filter[bundleId]={bundle_id}&limit=10")
    if code != 200:
        print("App lookup failed:", code, data, file=sys.stderr)
        sys.exit(1)
    apps = data.get("data", [])
    if not apps:
        print(f"No app found for bundle id {bundle_id}", file=sys.stderr)
        sys.exit(1)
    if len(apps) > 1:
        for a in apps:
            print(f"- {a['id']}  {a['attributes'].get('name')}")
        print("Multiple apps matched; refine the bundle id.", file=sys.stderr)
        sys.exit(1)
    app = apps[0]
    print(f"App: {app['attributes'].get('name')} id={app['id']}")
    return app


def list_versions(api, app_id):
    code, data = api(f"/v1/apps/{app_id}/appStoreVersions?limit=50")
    if code != 200:
        print("Version listing failed:", code, data, file=sys.stderr)
        sys.exit(1)
    return data.get("data", [])


def show(version, mark=False):
    at = version["attributes"]
    print(f"- {at.get('versionString')}  build={at.get('buildNumber') or '-'}  "
          f"state={at.get('appStoreState')}  platform={at.get('platform')}  "
          f"id={version['id']}" + ("  <-- MATCH" if mark else ""))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bundle-id", required=True)
    p.add_argument("--version")
    p.add_argument("--platform", default="MAC_OS")
    p.add_argument("--rename-to")
    p.add_argument("--list", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    api = make_api()
    app = find_app(api, args.bundle_id)
    versions = list_versions(api, app["id"])

    print("Versions on record:")
    matches = []
    for v in versions:
        at = v["attributes"]
        hit = bool(args.version and at.get("versionString") == args.version
                   and at.get("platform") == args.platform)
        if hit:
            matches.append(v)
        show(v, mark=hit)

    if args.list or not args.version:
        return

    if not matches:
        print(f"No {args.platform} version {args.version} found.")
        return

    for v in matches:
        at = v["attributes"]
        state = at.get("appStoreState")
        if state not in EDITABLE_STATES:
            print(f"SKIP {args.version} ({state}): not editable via API.", file=sys.stderr)
            continue
        if args.dry_run:
            action = f"rename to {args.rename_to}" if args.rename_to else "delete"
            print(f"DRY RUN: would {action} {args.platform} {args.version} "
                  f"(id={v['id']}, state={state})")
            continue
        if args.rename_to:
            code, resp = api(f"/v1/appStoreVersions/{v['id']}", method="PATCH",
                             data={"data": {"type": "appStoreVersions", "id": v["id"],
                                            "attributes": {"versionString": args.rename_to}}})
            if code == 200:
                print(f"RENAMED {args.platform} {args.version} -> {args.rename_to} (id={v['id']})")
            else:
                print(f"RENAME FAILED for id={v['id']}: HTTP {code}", file=sys.stderr)
                print(json.dumps(resp, indent=2)[:1200], file=sys.stderr)
                sys.exit(1)
        else:
            code, resp = api(f"/v1/appStoreVersions/{v['id']}", method="DELETE")
            if code in (200, 204):
                print(f"DELETED {args.platform} version {args.version} (id={v['id']})")
            else:
                print(f"DELETE FAILED for id={v['id']}: HTTP {code}", file=sys.stderr)
                print(json.dumps(resp, indent=2)[:1200], file=sys.stderr)
                sys.exit(1)


if __name__ == "__main__":
    main()
