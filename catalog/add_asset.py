#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
手动添加/校验单个 asset 文件的 CLI 工具（选项 C）。

同时暴露 `create_asset()` 给 app.py 的 POST /api/assets 使用。

不自动推导 symbol，只负责：
1. 格式化输出最小化 asset JSON；
2. 校验必填字段、region/group 合法性、ID 唯一性；
3. 提示 symbols 与 providers.json 的匹配情况；
4. 自动调用 catalog/build.py 重新生成完整 catalog。

示例：
    python catalog/add_asset.py add \
        --region cn --group stock \
        --id cn_stock_demo \
        --name-zh 示例股份 \
        --name-en "Demo Co." \
        --market "Shanghai Stock Exchange" \
        --symbol tradingview=SSE:000001 \
        --symbol yahoo=000001.SS \
        --tags china,tech,a-share

    python catalog/add_asset.py template --region cn --group stock --id cn_stock_demo

    python catalog/add_asset.py validate
"""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from build import load_json, save_json, walk_assets, validate_uniqueness, build_asset

CATALOG_DIR = Path(__file__).resolve().parent
META_DIR = CATALOG_DIR / "_meta"
ASSETS_DIR = CATALOG_DIR / "assets"
BUILD_PY = CATALOG_DIR / "build.py"

REQUIRED_FIELDS = {"id", "name", "market", "currency", "symbols"}

# 保证 Windows 终端下中文输出正常
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def load_meta() -> tuple[dict, dict, dict, dict]:
    """加载 providers、regions、market_groups，返回 (providers, link_semantics, regions, groups)。"""
    providers_meta = load_json(META_DIR / "providers.json")
    providers = providers_meta.get("providers", {})
    link_semantics = providers_meta.get("link_semantics", {})
    regions = load_json(META_DIR / "regions.json")
    groups = load_json(META_DIR / "market_groups.json")
    return providers, link_semantics, regions, groups


def list_existing_assets() -> dict[str, Path]:
    """返回已有 asset id → 文件路径的映射。"""
    seen: dict[str, Path] = {}
    for path, _, _ in walk_assets(ASSETS_DIR):
        raw = load_json(path)
        aid = raw.get("id")
        if aid:
            seen[aid] = path
    return seen


def ordered_asset(asset: dict) -> dict:
    """按约定顺序排列 asset 字段，便于 diff。"""
    order = ["id", "name", "market", "currency", "symbols", "tags", "note", "link_overrides", "links"]
    result: dict[str, Any] = {}
    for key in order:
        if key in asset:
            result[key] = asset[key]
    for key in asset:
        if key not in result:
            result[key] = asset[key]
    return result


def ordered_name(name: dict) -> dict:
    """name 字段固定 zh 在前；en 可选，为空时省略。"""
    result: dict = {"zh": name.get("zh", "")}
    en = name.get("en", "")
    if en:
        result["en"] = en
    return result


def known_symbol_keys(providers: dict) -> set[str]:
    """返回所有需要显式提供的 symbol_key 集合。"""
    keys: set[str] = set()
    for cfg in providers.values():
        key = cfg.get("symbol_key")
        if key:
            keys.add(key)
    return keys


def providers_by_symbol_key(providers: dict) -> dict[str, list[str]]:
    """返回 symbol_key → [provider_name, ...] 的映射，用于提示。"""
    mapping: dict[str, list[str]] = {}
    for name, cfg in providers.items():
        key = cfg.get("symbol_key")
        if key:
            mapping.setdefault(key, []).append(name)
    return mapping


def derive_symbols(
    exchange: str,
    code: str,
    region_code: str,
    market_group: str,
    regions: dict,
    groups: dict,
) -> dict[str, Any]:
    """
    根据交易所 + 代码 + 分类自动推导常用 symbol。

    返回：
    {
      "symbols": {symbol_key: symbol, ...},
      "variants": {variant_name: value, ...}
    }
    - symbols 的 key 是 provider 的 symbol_key，会写入 asset 文件。
    - variants 是 provider 模板里实际会用到的占位符变体，用于前端预览。
    """
    exchange = (exchange or "").strip().upper()
    code = (code or "").strip()
    if not exchange or not code:
        return {"symbols": {}, "variants": {}}

    group_info = groups.get(market_group, {})
    asset_class = group_info.get("asset_class", market_group)

    symbols: dict[str, str] = {}

    # TradingView symbol 是推导基准
    symbols["tradingview"] = f"{exchange}:{code}"

    # Yahoo Finance：按 region/exchange 给后缀
    yahoo_suffix = {
        "SSE": ".SS",
        "SZSE": ".SZ",
        "HKEX": ".HK",
        "TSE": ".T",
        "TWSE": ".TW",
        "LSE": ".L",
    }.get(exchange, "")
    if region_code == "us" or exchange in ("NASDAQ", "NYSE", "AMEX"):
        yahoo_suffix = ""
    # 已知可推导 suffix 的 region/exchange 才生成 yahoo
    if yahoo_suffix != "" or region_code in ("cn", "hk", "jp", "tw", "uk") or exchange in ("NASDAQ", "NYSE", "AMEX"):
        symbols["yahoo"] = f"{code}{yahoo_suffix}"

    # Google Finance：按交易所给后缀
    google_suffix = {
        "SSE": "SHA",
        "SZSE": "SHE",
        "HKEX": "HKG",
        "NASDAQ": "NASDAQ",
        "NYSE": "NYSE",
        "AMEX": "AMEX",
        "TSE": "TYO",
        "TWSE": "TPE",
        "LSE": "LON",
    }.get(exchange, "")
    if google_suffix:
        symbols["google"] = f"{code}:{google_suffix}"

    # 调用 build.py 的 symbol_vars 获取模板变体（如 sina/eastmoney/xueqiu/10jqka/futu）
    from build import symbol_vars
    fake_asset = {"asset_class": asset_class, "symbols": symbols}
    vars_ = symbol_vars(symbols["tradingview"], fake_asset)

    # 只保留用户关心的 provider 变体
    variant_names = {
        "symbol_sina": "新浪 finance",
        "symbol_eastmoney": "东方财富",
        "symbol_xueqiu": "雪球",
        "symbol_10jqka": "同花顺",
        "symbol_futu": "富途",
        "symbol_marketwatch": "MarketWatch",
        "symbol_upper": "StockTwits",
    }
    variants = {label: vars_[key] for key, label in variant_names.items() if key in vars_}

    return {"symbols": symbols, "variants": variants}


def validate_asset(
    asset: dict,
    region_code: str,
    market_group: str,
    regions: dict,
    groups: dict,
    providers: dict,
    seen_ids: dict[str, Path] | None = None,
    path: Path | None = None,
) -> list[str]:
    """校验单个 asset，返回错误列表（空表示通过）。"""
    errors: list[str] = []
    aid = asset.get("id")

    # 必填字段
    missing = REQUIRED_FIELDS - set(asset.keys())
    if missing:
        errors.append(f"缺少必填字段: {sorted(missing)}")

    # name 子字段
    name = asset.get("name") or {}
    if not isinstance(name, dict):
        errors.append("name 必须是对象")
    else:
        if not name.get("zh"):
            errors.append("name.zh 不能为空")
        # name.en 改为可选

    # region/group 合法性
    if region_code not in regions:
        errors.append(f"未知 region: {region_code}")
    if market_group not in groups:
        errors.append(f"未知 market_group: {market_group}")

    # symbols 类型
    symbols = asset.get("symbols")
    if symbols is not None and not isinstance(symbols, dict):
        errors.append("symbols 必须是对象")

    # ID 唯一性
    if aid and seen_ids:
        existing = seen_ids.get(aid)
        if existing and existing != path:
            errors.append(f"id 重复: {aid} 已存在于 {existing}")

    return errors


def check_symbols_coverage(
    asset: dict,
    providers: dict,
    region_code: str,
    market_group: str,
    regions: dict,
    groups: dict,
) -> list[str]:
    """检查 symbols 是否能生成链接，返回 warning 列表。"""
    warnings: list[str] = []
    symbols = asset.get("symbols", {})
    known_keys = known_symbol_keys(providers)
    by_key = providers_by_symbol_key(providers)

    # 未知 symbol key 警告
    for key in symbols:
        if key not in known_keys:
            warnings.append(f"symbol key '{key}' 未匹配任何 provider 的 symbol_key，将不会生成链接")

    # 检查每个 provider 能否生成链接
    try:
        built = build_asset(asset, region_code, market_group, regions, groups, providers)
        links = built.get("links", {})
        jump_count = len(links.get("jump", []))
        embed_count = len(links.get("embed", []))
        crawl_count = len(links.get("crawl", []))
        if jump_count + embed_count + crawl_count == 0:
            warnings.append("当前 symbols 未生成任何链接或 embed，确认是否需要添加更多 symbol")
    except Exception as e:
        warnings.append(f"构建预览失败: {e}")

    # 对每个 symbol_key 提示会生成哪些 provider 的链接
    for key, providers_list in sorted(by_key.items()):
        if key in symbols and symbols[key]:
            warnings.append(f"symbol '{key}={symbols[key]}' 将为 {', '.join(providers_list)} 生成链接")

    # 无统一规则的 provider 提示
    for name, cfg in sorted(providers.items()):
        if cfg.get("symbol_key") is None:
            warnings.append(f"provider '{name}' 无统一 symbol 规则，如需其链接请在 asset 中显式写 links")

    return warnings


def prepare_asset(payload: dict) -> dict:
    """把 API/CLI 输入整理成标准 asset 字典，保持字段顺序。"""
    # name
    raw_name = payload.get("name") or {}
    name = ordered_name({
        "zh": raw_name.get("zh") or payload.get("name_zh", ""),
        "en": raw_name.get("en") or payload.get("name_en", ""),
    })

    # symbols：过滤空值
    raw_symbols = payload.get("symbols") or {}
    symbols = {k.strip(): str(v).strip() for k, v in raw_symbols.items() if str(v).strip()}

    # tags：支持列表或逗号字符串
    raw_tags = payload.get("tags") or []
    if isinstance(raw_tags, str):
        raw_tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
    tags = sorted({str(t).strip() for t in raw_tags if str(t).strip()})

    asset: dict[str, Any] = {
        "id": str(payload.get("id", "")).strip(),
        "name": name,
        "market": str(payload.get("market", "")).strip(),
        "currency": str(payload.get("currency", "")).strip(),
        "symbols": symbols,
    }
    if tags:
        asset["tags"] = tags
    note = payload.get("note")
    note = str(note).strip() if note is not None else ""
    if note:
        asset["note"] = note
    if payload.get("links"):
        asset["links"] = payload.get("links")
    return ordered_asset(asset)


def create_asset(
    asset: dict,
    region_code: str,
    market_group: str,
    *,
    dry_run: bool = False,
    run_build: bool = True,
    allow_overwrite: bool = False,
) -> dict:
    """
    核心创建逻辑，供 CLI 和 API 共用。

    返回：
    {
      "ok": bool,
      "path": str | None,
      "errors": list[str],
      "warnings": list[str],
      "asset": dict | None
    }
    """
    providers, _, regions, groups = load_meta()
    seen_ids = list_existing_assets()

    errors = validate_asset(
        asset, region_code, market_group, regions, groups, providers, seen_ids
    )
    if errors:
        return {"ok": False, "path": None, "errors": errors, "warnings": [], "asset": None}

    warnings = check_symbols_coverage(asset, providers, region_code, market_group, regions, groups)

    target_dir = ASSETS_DIR / region_code / market_group
    target_path = target_dir / f"{asset['id']}.json"

    if target_path.exists() and not allow_overwrite:
        return {
            "ok": False,
            "path": str(target_path),
            "errors": [f"文件已存在: {target_path}，如需编辑请直接修改文件"],
            "warnings": warnings,
            "asset": None,
        }

    if dry_run:
        return {"ok": True, "path": str(target_path), "errors": [], "warnings": warnings, "asset": asset}

    target_dir.mkdir(parents=True, exist_ok=True)
    save_json(target_path, asset)

    if run_build:
        try:
            result = subprocess.run(
                [sys.executable, str(BUILD_PY)],
                cwd=str(CATALOG_DIR),
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                errors.append(f"catalog 构建失败: {result.stderr or result.stdout}")
                return {"ok": False, "path": str(target_path), "errors": errors, "warnings": warnings, "asset": asset}
        except Exception as e:
            return {"ok": False, "path": str(target_path), "errors": [f"调用 build.py 失败: {e}"], "warnings": warnings, "asset": asset}

    return {"ok": True, "path": str(target_path), "errors": [], "warnings": warnings, "asset": asset}


def find_asset_path(asset_id: str) -> Path | None:
    """根据 asset id 查找文件路径。"""
    seen = list_existing_assets()
    return seen.get(asset_id)


def update_asset(
    asset: dict,
    region_code: str,
    market_group: str,
    old_asset_id: str,
    *,
    dry_run: bool = False,
    run_build: bool = True,
) -> dict:
    """
    更新已有资产。
    如果 region/group 改变，会移动文件到新目录；如果 id 改变，会重命名文件。
    """
    providers, _, regions, groups = load_meta()
    seen_ids = list_existing_assets()

    old_path = seen_ids.get(old_asset_id)
    if not old_path:
        return {"ok": False, "path": None, "errors": [f"未找到资产: {old_asset_id}"], "warnings": [], "asset": None}

    new_id = asset.get("id", old_asset_id)

    # 校验时排除旧 id 自身，避免被自己判定为重复
    temp_seen = {k: v for k, v in seen_ids.items() if k != old_asset_id}
    errors = validate_asset(asset, region_code, market_group, regions, groups, providers, temp_seen)
    if errors:
        return {"ok": False, "path": None, "errors": errors, "warnings": [], "asset": None}

    warnings = check_symbols_coverage(asset, providers, region_code, market_group, regions, groups)

    target_dir = ASSETS_DIR / region_code / market_group
    target_path = target_dir / f"{new_id}.json"

    if dry_run:
        return {"ok": True, "path": str(target_path), "errors": [], "warnings": warnings, "asset": asset}

    target_dir.mkdir(parents=True, exist_ok=True)
    save_json(target_path, asset)

    # 如果路径变化，删除旧文件
    if old_path.resolve() != target_path.resolve():
        old_path.unlink(missing_ok=True)
        # 清理空目录
        for p in [old_path.parent, old_path.parent.parent]:
            try:
                if p.exists() and not any(p.iterdir()):
                    p.rmdir()
            except OSError:
                pass

    if run_build:
        try:
            result = subprocess.run(
                [sys.executable, str(BUILD_PY)],
                cwd=str(CATALOG_DIR),
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                return {"ok": False, "path": str(target_path), "errors": [f"catalog 构建失败: {result.stderr or result.stdout}"], "warnings": warnings, "asset": asset}
        except Exception as e:
            return {"ok": False, "path": str(target_path), "errors": [f"调用 build.py 失败: {e}"], "warnings": warnings, "asset": asset}

    return {"ok": True, "path": str(target_path), "errors": [], "warnings": warnings, "asset": asset}


def delete_asset(asset_id: str, *, run_build: bool = True) -> dict:
    """删除资产文件并重建 catalog。"""
    seen_ids = list_existing_assets()
    path = seen_ids.get(asset_id)
    if not path:
        return {"ok": False, "path": None, "errors": [f"未找到资产: {asset_id}"], "warnings": []}

    try:
        path.unlink(missing_ok=True)
        # 清理空目录
        for p in [path.parent, path.parent.parent]:
            try:
                if p.exists() and not any(p.iterdir()):
                    p.rmdir()
            except OSError:
                pass
    except Exception as e:
        return {"ok": False, "path": str(path), "errors": [f"删除失败: {e}"], "warnings": []}

    if run_build:
        try:
            result = subprocess.run(
                [sys.executable, str(BUILD_PY)],
                cwd=str(CATALOG_DIR),
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                return {"ok": False, "path": str(path), "errors": [f"catalog 构建失败: {result.stderr or result.stdout}"], "warnings": []}
        except Exception as e:
            return {"ok": False, "path": str(path), "errors": [f"调用 build.py 失败: {e}"], "warnings": []}

    return {"ok": True, "path": str(path), "errors": [], "warnings": []}


def cmd_add(args: argparse.Namespace) -> int:
    providers, _, regions, groups = load_meta()

    symbols: dict[str, str] = {}

    # 自动推导
    if args.exchange and args.code:
        derived = derive_symbols(args.exchange, args.code, args.region, args.group, regions, groups)
        symbols = derived.get("symbols", {})

    # 覆盖或补充
    if args.symbol:
        for item in args.symbol:
            if "=" not in item:
                raise ValueError(f"--symbol 格式错误: {item}，应为 provider=code")
            key, value = item.split("=", 1)
            symbols[key.strip()] = value.strip()

    currency = args.currency
    if not currency and args.region in regions:
        currency = regions[args.region].get("currency_default", "USD")

    payload = {
        "id": args.id,
        "name_zh": args.name_zh,
        "name_en": args.name_en,
        "market": args.market,
        "currency": currency,
        "symbols": symbols,
        "tags": args.tags,
        "note": args.note,
    }
    if args.links_json:
        payload["links"] = json.loads(args.links_json)

    asset = prepare_asset(payload)
    result = create_asset(asset, args.region, args.group, dry_run=args.dry_run, run_build=not args.no_build)

    for w in result.get("warnings", []):
        print(f"[提示] {w}")

    if not result["ok"]:
        for err in result.get("errors", []):
            print(f"[错误] {err}", file=sys.stderr)
        return 1

    if args.dry_run:
        print(f"--- dry-run 将写入: {result['path']} ---")
        print(json.dumps(result['asset'], ensure_ascii=False, indent=2))
    else:
        print(f"已创建: {result['path']}")
    if args.no_build:
        print("已跳过 build，可手动运行: python catalog/build.py")

    return 0


def cmd_template(args: argparse.Namespace) -> int:
    providers, _, regions, groups = load_meta()

    if args.region not in regions:
        print(f"[错误] 未知 region: {args.region}", file=sys.stderr)
        return 1
    if args.group not in groups:
        print(f"[错误] 未知 market_group: {args.group}", file=sys.stderr)
        return 1

    currency = args.currency
    if not currency:
        currency = regions[args.region].get("currency_default", "USD")
    keys = sorted(known_symbol_keys(providers))
    symbols = {key: "" for key in keys}

    asset = ordered_asset({
        "id": args.id,
        "name": ordered_name({"zh": args.name_zh or "", "en": args.name_en or ""}),
        "market": args.market or "",
        "currency": currency,
        "symbols": symbols,
        "tags": [],
        "note": "",
    })

    output = json.dumps(asset, ensure_ascii=False, indent=2)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output + "\n", encoding="utf-8")
        print(f"模板已保存: {out_path}")
    else:
        print(output)

    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    providers, _, regions, groups = load_meta()

    if args.file:
        path = Path(args.file).resolve()
        raw = load_json(path)
        if not isinstance(raw, dict):
            print(f"[错误] {path} 不是 JSON 对象", file=sys.stderr)
            return 1

        # 从路径推断 region/group
        try:
            rel = path.relative_to(ASSETS_DIR.resolve())
            parts = rel.parts
            region_code = parts[0]
            market_group = parts[1]
        except ValueError:
            region_code = ""
            market_group = ""

        seen_ids = list_existing_assets()
        errors = validate_asset(raw, region_code, market_group, regions, groups, providers, seen_ids, path)
        if errors:
            for err in errors:
                print(f"[错误] {err}", file=sys.stderr)
            return 1

        warnings = check_symbols_coverage(raw, providers, region_code, market_group, regions, groups)
        for w in warnings:
            print(f"[提示] {w}")

        print(f"{path} 校验通过")
        return 0

    # 校验全部
    all_assets: list[dict] = []
    seen_ids: dict[str, Path] = {}
    errors: list[str] = []

    for path, region_code, market_group in walk_assets(ASSETS_DIR):
        raw = load_json(path)
        all_assets.append(raw)
        asset_errors = validate_asset(raw, region_code, market_group, regions, groups, providers, seen_ids, path)
        if asset_errors:
            errors.append(f"{path}: " + "; ".join(asset_errors))
        aid = raw.get("id")
        if aid:
            if aid in seen_ids:
                errors.append(f"{path}: id 重复: {aid} 已存在于 {seen_ids[aid]}")
            else:
                seen_ids[aid] = path

    dup_errors = validate_uniqueness(all_assets)
    errors.extend(dup_errors)

    if errors:
        for err in errors:
            print(f"[错误] {err}", file=sys.stderr)
        return 1

    print(f"全部 {len(all_assets)} 个 asset 文件校验通过")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="add_asset.py",
        description="手动添加/校验 catalog/assets/ 下的单个资产文件",
    )
    sub = ap.add_subparsers(dest="command", required=True)

    # add
    add_p = sub.add_parser("add", help="创建新资产文件")
    add_p.add_argument("--region", required=True, help="region 短代码，如 cn/us/hk")
    add_p.add_argument("--group", required=True, help="market_group，如 index/stock/crypto")
    add_p.add_argument("--id", required=True, help="资产唯一 id")
    add_p.add_argument("--name-zh", required=True, help="中文名称")
    add_p.add_argument("--name-en", help="英文名称（可选）")
    add_p.add_argument("--market", required=True, help="市场/交易所名称")
    add_p.add_argument("--currency", help="货币代码（默认从 regions.json 取）")
    add_p.add_argument("--exchange", help="交易所代码，如 SSE/SZSE/NASDAQ/HKEX")
    add_p.add_argument("--code", help="标的代码，如 600519/AAPL/00700")
    add_p.add_argument("--symbol", action="append", help="symbol 键值对，可多次传入，覆盖自动推导结果，如 --symbol coinmarketcap=bitcoin")
    add_p.add_argument("--tags", help="标签，逗号分隔，如 china,tech,a-share")
    add_p.add_argument("--note", help="备注")
    add_p.add_argument("--links-json", help='显式 links JSON，如 {"jump": [...]}')
    add_p.add_argument("--dry-run", action="store_true", help="只打印结果，不写文件")
    add_p.add_argument("--no-build", action="store_true", help="创建后不调用 build.py")
    add_p.set_defaults(func=cmd_add)

    # template
    tpl_p = sub.add_parser("template", help="输出空白模板")
    tpl_p.add_argument("--region", required=True, help="region 短代码")
    tpl_p.add_argument("--group", required=True, help="market_group")
    tpl_p.add_argument("--id", required=True, help="资产 id")
    tpl_p.add_argument("--name-zh", help="中文名称（可选）")
    tpl_p.add_argument("--name-en", help="英文名称（可选）")
    tpl_p.add_argument("--market", help="市场名称（可选）")
    tpl_p.add_argument("--currency", help="货币代码（默认从 regions.json 取）")
    tpl_p.add_argument("--output", help="输出文件路径（默认 stdout）")
    tpl_p.set_defaults(func=cmd_template)

    # validate
    val_p = sub.add_parser("validate", help="校验资产文件")
    val_p.add_argument("--file", help="单个 asset 文件路径（默认校验全部）")
    val_p.set_defaults(func=cmd_validate)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
