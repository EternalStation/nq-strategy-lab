from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

from server.data_service import (
    build_derived_timeframes,
    download_history,
    get_dataset_range,
    inspect_coverage,
    quote_download,
    save_dataset_conditions,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="NQ Databento data manager")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("range")
    subparsers.add_parser("coverage")
    subparsers.add_parser("build")

    conditions = subparsers.add_parser("conditions")
    conditions.add_argument("--start", required=True)
    conditions.add_argument("--end", required=True)

    for name in ("quote", "download"):
        child = subparsers.add_parser(name)
        child.add_argument("--start", required=True)
        child.add_argument("--end", required=True)
        if name == "download":
            child.add_argument("--max-cost", type=float, default=None)

    args = parser.parse_args()
    if args.command == "range":
        result = get_dataset_range()
    elif args.command == "coverage":
        result = inspect_coverage()
    elif args.command == "build":
        result = build_derived_timeframes()
    elif args.command == "conditions":
        result = save_dataset_conditions(args.start, args.end)
    elif args.command == "quote":
        result = quote_download(args.start, args.end)
    else:
        result = download_history(args.start, args.end, args.max_cost)
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
