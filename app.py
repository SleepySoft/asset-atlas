#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Market Catalog Engine - backend.

Responsibilities:
- Serve static files from static/ (HTML/CSS/JS).
- Load and validate market_sources_catalog.json.
- Expose REST API for the dashboard frontend.
- Support reload / export / validate / save.
"""
from __future__ import annotations
import argparse
import json
import mimetypes
import os
import shutil
import sys
import tempfile
import time
import urllib.parse
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Default catalog is the generated output from catalog/build.py
DEFAULT_CATALOG = "catalog/dist/market_sources_catalog.json"
STATIC_DIR = Path(__file__).resolve().parent / "static"
CATALOG_DIR = Path(__file__).resolve().parent / "catalog"


def load_add_asset_module():
    """动态加载 catalog/add_asset.py，复用其 create_asset 等函数。"""
    import importlib.util
    # 临时把 catalog/ 加入 sys.path，让 add_asset.py 能导入同目录的 build.py
    catalog_dir = str(CATALOG_DIR)
    inserted = catalog_dir not in sys.path
    if inserted:
        sys.path.insert(0, catalog_dir)
    try:
        spec = importlib.util.spec_from_file_location("add_asset", CATALOG_DIR / "add_asset.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if inserted:
            sys.path.remove(catalog_dir)


ADD_ASSET = load_add_asset_module()


def assets(cat: dict) -> list[dict]:
    out = []
    for rg in cat.get("regions", []) or []:
        for mg in rg.get("market_groups", []) or []:
            for a in mg.get("assets", []) or []:
                out.append(a)
    return out


def validate(cat: dict) -> tuple[bool, list[str]]:
    if not isinstance(cat, dict):
        return False, ["catalog must be object"]
    if not isinstance(cat.get("regions", []), list):
        return False, ["regions must be list"]
    seen = set()
    errs = []
    for a in assets(cat):
        aid = a.get("id") if isinstance(a, dict) else None
        if not aid:
            errs.append("asset.id required")
        elif aid in seen:
            errs.append("duplicate asset.id: " + aid)
        else:
            seen.add(aid)
    return not errs, errs


class Store:
    def __init__(self, path: str):
        self.path = Path(path)
        self.catalog = self.load()

    def load(self) -> dict:
        if not self.path.exists():
            raise FileNotFoundError(f"catalog not found: {self.path}")
        cat = json.loads(self.path.read_text(encoding="utf-8"))
        ok, errs = validate(cat)
        if not ok:
            raise ValueError("; ".join(errs))
        return cat

    def reload(self) -> dict:
        self.catalog = self.load()
        return self.catalog

    def save(self, cat: dict) -> dict:
        ok, errs = validate(cat)
        if not ok:
            raise ValueError("; ".join(errs))
        cat["updated_at"] = datetime.now(timezone.utc).isoformat()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            shutil.copy2(
                self.path,
                self.path.with_suffix(self.path.suffix + "." + str(int(time.time())) + ".bak"),
            )
        fd, tmp = tempfile.mkstemp(
            prefix=self.path.name, suffix=".tmp", dir=str(self.path.parent or Path("."))
        )
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cat, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, self.path)
        self.catalog = cat
        return {"ok": True, "path": str(self.path), "updated_at": cat["updated_at"]}

    def stats(self) -> dict:
        ass = assets(self.catalog)
        links = 0
        for a in ass:
            l = a.get("links", {}) or {}
            links += (
                len(l.get("jump", []) or [])
                + len(l.get("embed", []) or [])
                + len(l.get("crawl", []) or [])
            )
        return {
            "assets": len(ass),
            "providers": len(self.catalog.get("providers", {}) or {}),
            "regions": len(self.catalog.get("regions", []) or []),
            "links": links,
            "path": str(self.path),
        }


class Handler(BaseHTTPRequestHandler):
    store: Store | None = None

    def log_message(self, fmt: str, *args) -> None:
        print(
            "[%s] %s %s"
            % (datetime.now().strftime("%H:%M:%S"), self.client_address[0], fmt % args)
        )

    def send_bytes(self, data: bytes, status: int = 200, content_type: str = "application/octet-stream", headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if headers:
            for k, v in headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def j(self, data, status: int = 200) -> None:
        b = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_bytes(b, status, "application/json; charset=utf-8")

    def h(self, text: str, status: int = 200) -> None:
        b = text.encode("utf-8")
        self.send_bytes(b, status, "text/html; charset=utf-8")

    def read_json(self):
        n = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else None

    def meta_response(self) -> dict:
        providers, _, regions, groups = ADD_ASSET.load_meta()
        return {"providers": providers, "regions": regions, "groups": groups}

    def serve_static(self, path: str) -> None:
        if path == "/":
            path = "/index.html"
        file_path = (STATIC_DIR / path.lstrip("/")).resolve()
        # Security: prevent escaping static dir
        if not str(file_path).startswith(str(STATIC_DIR.resolve())):
            self.j({"error": "not allowed"}, 403)
            return
        if not file_path.exists() or file_path.is_dir():
            self.j({"error": "not found"}, 404)
            return
        content_type, _ = mimetypes.guess_type(str(file_path))
        if content_type is None:
            content_type = "application/octet-stream"
        self.send_bytes(file_path.read_bytes(), 200, content_type)

    def do_GET(self) -> None:
        p = urllib.parse.urlparse(self.path).path
        if p in ("/", "/index.html"):
            self.serve_static("/index.html")
        elif p.startswith("/static/"):
            self.serve_static(p[len("/static"):])
        elif p == "/api/catalog":
            self.j(self.store.catalog)
        elif p == "/api/assets":
            self.j({"assets": assets(self.store.catalog)})
        elif p == "/api/stats":
            self.j(self.store.stats())
        elif p == "/api/meta":
            self.j(self.meta_response())
        elif p == "/api/derive-symbols":
            self.j(self.handle_derive_symbols())
        elif p == "/api/reload":
            try:
                self.j(self.store.reload())
            except Exception as e:
                self.j({"error": str(e)}, 400)
        elif p == "/api/export":
            b = json.dumps(self.store.catalog, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_bytes(
                b,
                200,
                "application/json; charset=utf-8",
                {"Content-Disposition": "attachment; filename=market_sources_catalog.export.json"},
            )
        else:
            self.j({"error": "not found"}, 404)

    def do_POST(self) -> None:
        p = urllib.parse.urlparse(self.path).path
        try:
            if p == "/api/catalog":
                self.j(self.store.save(self.read_json()))
            elif p == "/api/validate":
                ok, errs = validate(self.read_json())
                self.j({"ok": ok, "errors": errs})
            elif p == "/api/assets":
                self.j(self.handle_create_asset(self.read_json()))
            else:
                self.j({"error": "not found"}, 404)
        except Exception as e:
            self.j({"error": str(e)}, 400)

    def do_PUT(self) -> None:
        p = urllib.parse.urlparse(self.path).path
        try:
            if p.startswith("/api/assets/"):
                old_id = p[len("/api/assets/"):]
                self.j(self.handle_update_asset(old_id, self.read_json()))
            else:
                self.j({"error": "not found"}, 404)
        except Exception as e:
            self.j({"error": str(e)}, 400)

    def do_DELETE(self) -> None:
        p = urllib.parse.urlparse(self.path).path
        try:
            if p.startswith("/api/assets/"):
                asset_id = p[len("/api/assets/"):]
                self.j(self.handle_delete_asset(asset_id))
            else:
                self.j({"error": "not found"}, 404)
        except Exception as e:
            self.j({"error": str(e)}, 400)

    def handle_create_asset(self, payload: dict) -> dict:
        region_code = payload.get("region", "").strip()
        market_group = payload.get("group", "").strip()
        asset = ADD_ASSET.prepare_asset(payload)
        result = ADD_ASSET.create_asset(asset, region_code, market_group)
        if result["ok"]:
            self.store.reload()
        return result

    def handle_derive_symbols(self) -> dict:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        exchange = (query.get("exchange") or [""])[0].strip().upper()
        code = (query.get("code") or [""])[0].strip()
        region_code = (query.get("region") or [""])[0].strip()
        market_group = (query.get("group") or [""])[0].strip()
        if not exchange or not code:
            return {"symbols": {}, "variants": {}, "exchange": exchange, "code": code}
        providers, _, regions, groups = ADD_ASSET.load_meta()
        result = ADD_ASSET.derive_symbols(exchange, code, region_code, market_group, regions, groups)
        return {**result, "exchange": exchange, "code": code}

    def handle_update_asset(self, old_id: str, payload: dict) -> dict:
        region_code = payload.get("region", "").strip()
        market_group = payload.get("group", "").strip()
        asset = ADD_ASSET.prepare_asset(payload)
        result = ADD_ASSET.update_asset(asset, region_code, market_group, old_id)
        if result["ok"]:
            self.store.reload()
        return result

    def handle_delete_asset(self, asset_id: str) -> dict:
        result = ADD_ASSET.delete_asset(asset_id)
        if result["ok"]:
            self.store.reload()
        return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default=DEFAULT_CATALOG)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()

    Handler.store = Store(args.catalog)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("Market Catalog Engine")
    print("Catalog:", Path(args.catalog).resolve())
    print("Open: http://%s:%s/" % (args.host, args.port))
    print("Ctrl+C to stop")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("Stopping...")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
