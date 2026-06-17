#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 catalog/ 下的小 JSON 资产文件合并成一份完整的 market_sources_catalog.json。

设计原则：
1. 资产文件只保留“唯一信息”：id、name、market、currency、symbols、tags、note。
2. region / market_group / asset_class 从文件路径推断。
3. links 和 embed widget 由 providers.json 里的模板 + 通配符自动生成。
4. 遇到特殊/例外情况，允许 asset 文件里显式覆盖某条 link 或 widget。
"""
from __future__ import annotations
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
META_DIR = ROOT / "_meta"
ASSETS_DIR = ROOT / "assets"
DEFAULT_OUT = ROOT / "dist" / "market_sources_catalog.json"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # 原子写入：先写临时文件再替换
    fd, tmp = tempfile.mkstemp(prefix=path.name, suffix=".tmp", dir=str(path.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def symbol_vars(symbol: str, asset: dict | None = None) -> dict[str, str]:
    """为模板提供常用的 symbol 变体。"""
    base = {
        "symbol": symbol,
        "symbol_escaped": urllib.parse.quote(symbol, safe=""),
        "symbol_dash": symbol.replace(":", "-"),
        "symbol_lower": symbol.lower(),
    }

    # 解析 exchange:code，用于国内数据源通配符
    if ":" in symbol:
        exchange, code = symbol.split(":", 1)
    else:
        exchange, code = "", symbol
    exchange = exchange.upper()
    asset_class = (asset or {}).get("asset_class", "")

    # 新浪财经：A股/指数统一用 sh/sz 前缀
    if exchange == "SSE":
        base["symbol_sina"] = "sh" + code
    elif exchange == "SZSE":
        base["symbol_sina"] = "sz" + code

    # 东方财富
    if exchange in ("SSE", "SZSE"):
        prefix = "zs" if asset_class == "index" else ("sh" if exchange == "SSE" else "sz")
        base["symbol_eastmoney"] = prefix + code
    elif exchange == "HKEX":
        base["symbol_eastmoney"] = "hk" + code.zfill(5)
    elif exchange in ("NASDAQ", "NYSE", "AMEX"):
        base["symbol_eastmoney"] = code.lower()

    # 雪球
    if exchange == "SSE":
        base["symbol_xueqiu"] = "SH" + code
    elif exchange == "SZSE":
        base["symbol_xueqiu"] = "SZ" + code
    elif exchange == "HKEX":
        base["symbol_xueqiu"] = code.zfill(5)
    elif exchange in ("NASDAQ", "NYSE", "AMEX"):
        base["symbol_xueqiu"] = code.upper()

    # 同花顺：A股直接用数字代码
    if exchange in ("SSE", "SZSE"):
        base["symbol_10jqka"] = code

    # 富途：港股补零+HK，美股+US
    if exchange == "HKEX":
        base["symbol_futu"] = code.zfill(5) + "-HK"
    elif exchange in ("NASDAQ", "NYSE", "AMEX"):
        base["symbol_futu"] = code + "-US"

    # MarketWatch / StockTwits：美股/指数用大小写代码
    if exchange in ("NASDAQ", "NYSE", "AMEX", "SP"):
        base["symbol_upper"] = code.upper()
        base["symbol_marketwatch"] = code.lower()
        base["symbol_marketwatch_path"] = "index" if asset_class == "index" else "stock"

    return base


def placeholders(obj: Any) -> set[str]:
    """递归提取模板字符串里的 {placeholder} 集合。"""
    if isinstance(obj, str):
        return set(re.findall(r"\{(\w+)\}", obj))
    if isinstance(obj, list):
        result: set[str] = set()
        for item in obj:
            result.update(placeholders(item))
        return result
    if isinstance(obj, dict):
        result = set()
        for v in obj.values():
            result.update(placeholders(v))
        return result
    return set()


def render_template(obj: Any, variables: dict[str, str]) -> Any:
    """递归替换字符串里的 {placeholder}。"""
    if isinstance(obj, str):
        # 只替换存在的变量，避免 KeyError
        return obj.format_map(variables)
    if isinstance(obj, list):
        return [render_template(item, variables) for item in obj]
    if isinstance(obj, dict):
        return {k: render_template(v, variables) for k, v in obj.items()}
    return obj


def generate_links(asset: dict, provider_cfg: dict) -> list[dict]:
    """根据 provider 模板和 asset.symbols 生成 jump/crawl 链接。"""
    links: list[dict] = []
    symbol_key = provider_cfg.get("symbol_key")
    if not symbol_key:
        return links

    symbol = asset.get("symbols", {}).get(symbol_key)
    if not symbol:
        return links

    variables = symbol_vars(symbol, asset)
    provider_name = provider_cfg.get("_name", "")
    overrides = asset.get("link_overrides", {}).get(provider_name, {})

    for link_name, tmpl in provider_cfg.get("links", {}).items():
        # 如果模板需要的占位符在当前 symbol 下不存在（如美股用不到 symbol_sina），跳过
        if not placeholders(tmpl).issubset(variables):
            continue
        rendered = render_template(tmpl, variables)
        if link_name in overrides:
            rendered.update(overrides[link_name])
        links.append(rendered)
    return links


def generate_embeds(asset: dict, provider_cfg: dict) -> list[dict]:
    """生成 embed widget 配置。"""
    symbol_key = provider_cfg.get("symbol_key")
    if not symbol_key:
        return []

    symbol = asset.get("symbols", {}).get(symbol_key)
    if not symbol:
        return []

    variables = symbol_vars(symbol, asset)
    widgets = {}
    for widget_name, tmpl in provider_cfg.get("widgets", {}).items():
        widgets[widget_name] = render_template(tmpl, variables)

    if not widgets:
        return []

    return [{
        "provider": provider_cfg.get("_name", ""),
        "widgets": widgets,
        "recommended_widget": provider_cfg.get("recommended_widget")
    }]


def build_asset(raw: dict, region_code: str, market_group: str,
                regions: dict, groups: dict, providers_meta: dict) -> dict:
    """把单个资产文件 + 元数据 + provider 模板合并成最终 asset。"""
    region_info = regions.get(region_code, {})
    group_info = groups.get(market_group, {})

    asset = dict(raw)
    asset.setdefault("region", region_info.get("name", region_code))
    asset.setdefault("asset_class", group_info.get("asset_class", market_group))
    asset.setdefault("currency", region_info.get("currency_default", "USD"))

    jump_links: list[dict] = []
    embed_links: list[dict] = []
    crawl_links: list[dict] = []

    for provider_name, cfg in providers_meta.items():
        cfg = dict(cfg)
        cfg["_name"] = provider_name
        role = cfg.get("role", [])

        links = generate_links(asset, cfg)
        for link in links:
            link.setdefault("provider", provider_name)

        # 按 role 分发到 jump / crawl
        if "jump" in role:
            jump_links.extend(links)
        if "crawl" in role:
            # stooq 等 crawl 链接已经带 type/format/interval 字段
            crawl_links.extend(links)
        if "embed" in role:
            embed_links.extend(generate_embeds(asset, cfg))

    # 保留 asset 里显式写的 links（兜底/特例）
    explicit = asset.pop("links", None)
    if isinstance(explicit, dict):
        jump_links = explicit.get("jump", []) + jump_links
        embed_links = explicit.get("embed", []) + embed_links
        crawl_links = explicit.get("crawl", []) + crawl_links

    asset["links"] = {
        "jump": jump_links,
        "embed": embed_links,
        "crawl": crawl_links
    }
    return asset


def walk_assets(assets_dir: Path) -> list[tuple[Path, str, str]]:
    """遍历资产目录，返回 (path, region_code, market_group)。"""
    out: list[tuple[Path, str, str]] = []
    if not assets_dir.exists():
        return out
    for region_dir in sorted(assets_dir.iterdir()):
        if not region_dir.is_dir() or region_dir.name.startswith("_"):
            continue
        region_code = region_dir.name
        for group_dir in sorted(region_dir.iterdir()):
            if not group_dir.is_dir() or group_dir.name.startswith("_"):
                continue
            market_group = group_dir.name
            for asset_file in sorted(group_dir.glob("*.json")):
                out.append((asset_file, region_code, market_group))
    return out


def validate_uniqueness(assets: list[dict]) -> list[str]:
    seen: set[str] = set()
    errors: list[str] = []
    for a in assets:
        aid = a.get("id")
        if not aid:
            errors.append("asset.id missing")
        elif aid in seen:
            errors.append(f"duplicate asset.id: {aid}")
        else:
            seen.add(aid)
    return errors


def group_assets(assets: list[dict], regions: dict, groups: dict) -> list[dict]:
    """把资产列表按 region → market_group 分组，并附上中文标签。"""
    by_region: dict[str, dict[str, list[dict]]] = {}
    region_code_by_name: dict[str, str] = {
        info["name"]: code for code, info in regions.items()
    }

    for a in assets:
        region = a["region"]
        group = a.get("market_group", a.get("asset_class", "other"))
        by_region.setdefault(region, {}).setdefault(group, []).append(a)

    result: list[dict] = []
    for region_name in sorted(by_region.keys()):
        region_code = region_code_by_name.get(region_name, "")
        region_info = regions.get(region_code, {})
        market_groups: list[dict] = []
        for group_name in sorted(by_region[region_name].keys()):
            group_info = groups.get(group_name, {})
            market_groups.append({
                "market_group": group_name,
                "label": group_info.get("label", group_name),
                "label_zh": group_info.get("label_zh", group_name),
                "assets": by_region[region_name][group_name]
            })
        result.append({
            "region": region_name,
            "region_zh": region_info.get("name_zh", region_name),
            "market_groups": market_groups
        })
    return result


def build(catalog_dir: Path, out_path: Path, backup: bool = True) -> dict:
    providers_meta = load_json(catalog_dir / "_meta" / "providers.json")
    regions = load_json(catalog_dir / "_meta" / "regions.json")
    groups = load_json(catalog_dir / "_meta" / "market_groups.json")

    providers = providers_meta.get("providers", {})
    link_semantics = providers_meta.get("link_semantics", {})

    assets: list[dict] = []
    for path, region_code, market_group in walk_assets(catalog_dir / "assets"):
        raw = load_json(path)
        if not isinstance(raw, dict):
            raise ValueError(f"{path} must be a JSON object")
        asset = build_asset(raw, region_code, market_group, regions, groups, providers)
        assets.append(asset)

    errors = validate_uniqueness(assets)
    if errors:
        raise ValueError("validation failed: " + "; ".join(errors))

    catalog = {
        "schema_version": providers_meta.get("schema_version", "0.3.0"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "language": "zh-CN",
        "purpose": "结构化金融市场入口：可抓取链接、可嵌入 widget、跳转链接。本文件由 catalog/build.py 生成，请勿直接手工修改。",
        "license_note": "仅做个人研究/内部工具入口。不同数据源有不同条款、频率限制和商业授权要求，生产或商业使用前应核对各提供方条款。",
        "link_semantics": link_semantics,
        "providers": {
            name: {k: v for k, v in cfg.items() if not k.startswith("_")}
            for name, cfg in providers.items()
        },
        "global_embeds": {},
        "regions": group_assets(assets, regions, groups)
    }

    if backup and out_path.exists():
        bak = out_path.with_suffix(out_path.suffix + f".{int(time.time())}.bak")
        shutil.copy2(out_path, bak)

    save_json(out_path, catalog)
    return catalog


def main() -> int:
    ap = argparse.ArgumentParser(description="Build market_sources_catalog.json from catalog/")
    ap.add_argument("--catalog-dir", default=str(ROOT), help="catalog directory")
    ap.add_argument("--output", default=str(DEFAULT_OUT), help="output JSON path")
    ap.add_argument("--no-backup", action="store_true", help="do not create .bak before overwrite")
    args = ap.parse_args()

    try:
        catalog = build(Path(args.catalog_dir), Path(args.output), backup=not args.no_backup)
        asset_count = sum(
            len(g.get("assets", []))
            for r in catalog.get("regions", [])
            for g in r.get("market_groups", [])
        )
        print(f"Built {args.output}")
        print(f"Assets: {asset_count}")
        print(f"Providers: {len(catalog.get('providers', {}))}")
        print(f"Regions: {len(catalog.get('regions', []))}")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
