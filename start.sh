#!/usr/bin/env bash
cd "$(dirname "$0")"
python3 app.py --catalog "${CATALOG:-catalog/dist/market_sources_catalog.json}" --port "${PORT:-8787}"
