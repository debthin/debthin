#!/usr/bin/env python3
"""
check_freshness.py - Assert the live debthin service is serving a recent build.

Run after upload. Catches the class of failure where the pipeline reports
success but users are served stale indexes anyway: a broken upload, a bucket
or binding pointed somewhere unexpected, or (as in the 2026-05/09 outage) the
pipeline silently not running for months.

Checks the published status.json, NOT the InRelease `Date` field. InRelease
copies Date from upstream, so a base suite like ubuntu/noble legitimately
reports its 2024 release date and can never be used as a freshness signal.
status.json carries debthin's own `built_at`.

Usage:
  python3 check_freshness.py --max-age-hours 48
  python3 check_freshness.py --url http://debthin.org/status.json
"""

import argparse
import datetime
import json
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "http://debthin.org/status.json"
DEFAULT_MAX_AGE_HOURS = 48


def fetch_status(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "debthin-freshness-check"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status} from {url}")
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    p = argparse.ArgumentParser(description="Assert the live service is serving a recent build")
    p.add_argument("--url", default=DEFAULT_URL, help=f"status.json URL (default: {DEFAULT_URL})")
    p.add_argument("--max-age-hours", type=float, default=DEFAULT_MAX_AGE_HOURS,
                   help=f"Fail if built_at is older than this (default: {DEFAULT_MAX_AGE_HOURS})")
    p.add_argument("--timeout", type=int, default=30, help="HTTP timeout in seconds")
    args = p.parse_args()

    try:
        status = fetch_status(args.url, args.timeout)
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, json.JSONDecodeError) as e:
        print(f"FAIL: cannot read {args.url}: {e}", file=sys.stderr)
        return 1

    built_at = status.get("built_at")
    if not built_at:
        print(f"FAIL: no built_at in {args.url}", file=sys.stderr)
        return 1

    try:
        built = datetime.datetime.strptime(built_at, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=datetime.timezone.utc
        )
    except ValueError as e:
        print(f"FAIL: unparseable built_at {built_at!r}: {e}", file=sys.stderr)
        return 1

    age = datetime.datetime.now(datetime.timezone.utc) - built
    age_hours = age.total_seconds() / 3600

    if not status.get("valid", False) or status.get("errors", 0) != 0:
        print(
            f"FAIL: live build reports valid={status.get('valid')} "
            f"errors={status.get('errors')} (built_at {built_at})",
            file=sys.stderr,
        )
        return 1

    if age_hours > args.max_age_hours:
        print(
            f"FAIL: live index is stale - built_at {built_at} is "
            f"{age_hours:.1f}h old (limit {args.max_age_hours}h)",
            file=sys.stderr,
        )
        return 1

    distros = ", ".join(sorted(status.get("distros", {}).keys()))
    print(f"OK: live build {built_at} is {age_hours:.1f}h old; distros: {distros}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
