# Catalog 分体式配置

把原来 6000+ 行的 `market_sources_catalog.json` 拆成可维护的小文件。

## 目录结构

```
catalog/
├── _meta/
│   ├── providers.json      # provider 角色、URL 模板、widget 模板
│   ├── regions.json        # region 短代码 → 完整名称、默认货币
│   └── market_groups.json  # market_group → asset_class 映射
├── assets/
│   ├── cn/
│   │   ├── index/          # 指数
│   │   └── stock/          # 个股
│   ├── hk/
│   │   ├── index/
│   │   └── stock/
│   ├── us/
│   │   ├── index/
│   │   └── stock/
│   └── global/
│       ├── commodity/
│       ├── fx/
│       └── crypto/
└── build.py                # 构建脚本：把小文件合并成完整 JSON
```

## 资产文件格式

每个资产文件只保留“唯一信息”：

```json
{
  "id": "cn_index_sse_composite",
  "name": { "zh": "上证综指", "en": "SSE Composite Index" },
  "market": "Shanghai Stock Exchange",
  "currency": "CNY",
  "symbols": {
    "tradingview": "SSE:000001",
    "yahoo": "000001.SS",
    "google": "000001:SHA"
  },
  "tags": ["china", "a-share", "index"],
  "note": "中国大陆股票市场综合指数"
}
```

- `region` 从路径 `assets/cn/...` 自动推断为 `Asia/China`。
- `market_group` 从路径 `.../index/...` 自动推断为 `index`。
- `asset_class` 从 `market_groups.json` 自动映射。
- `currency` 默认继承 region 的 `currency_default`，可显式覆盖。
- `links` / `embed` 由 `providers.json` 模板自动生成，**不需要手写**。

## Provider 模板与通配符

**资产文件里的 `symbols` 是数据，provider 模板里的 `{symbol}` 是占位符，二者不是一回事。**

假设资产文件里写了：

```json
"symbols": {
  "tradingview": "SSE:000001"
}
```

构建时，`providers.json` 里 TradingView 的模板：

```json
"symbol_page": {
  "url": "https://www.tradingview.com/symbols/{symbol_dash}/"
},
"daily_chart": {
  "url": "https://www.tradingview.com/chart/?symbol={symbol_escaped}"
}
```

会被替换成：

```json
"symbol_page": {
  "url": "https://www.tradingview.com/symbols/SSE-000001/"
},
"daily_chart": {
  "url": "https://www.tradingview.com/chart/?symbol=SSE%3A000001"
}
```

### 占位符说明

| 占位符 | 含义 | 示例 |
|---|---|---|
| `{symbol}` | 原始 symbol | `SSE:000001` |
| `{symbol_escaped}` | URL 编码后 | `SSE%3A000001` |
| `{symbol_dash}` | `:` 替换为 `-` | `SSE-000001` |
| `{symbol_lower}` | 小写 | `sse:000001` |
| `{symbol_upper}` | 大写 | `SSE:000001` |
| `{symbol_sina}` | 新浪财经格式 | `sh000001` |
| `{symbol_eastmoney}` | 东方财富格式 | `zs000001`（指数）/`sh600519`（个股） |
| `{symbol_xueqiu}` | 雪球格式 | `SH000001` |
| `{symbol_10jqka}` | 同花顺 A股代码 | `600519` |
| `{symbol_futu}` | 富途格式 | `00700-HK`、`AAPL-US` |
| `{symbol_marketwatch}` | MarketWatch 代码 | `spx`、`aapl` |
| `{symbol_marketwatch_path}` | MarketWatch 路径段 | `index`、`stock` |

为什么需要多种形态？因为同一个 symbol 在不同 URL 场景下格式不同：

- TradingView symbol page 路径要 `SSE-000001`
- TradingView chart 查询参数要 `SSE%3A000001`
- Widget 配置里要原始 `SSE:000001`
- 新浪财经 A股/指数统一用 `sh000001`、`sz399001`
- 东方财富指数用 `zs000001`，个股用 `sh600519`
- 雪球 A股用 `SH600519`、`SZ000001`，港股自动补零为 `00700`
- 同花顺 A股直接用数字代码 `600519`
- 富途港股补零加 `-HK`，美股加 `-US`
- MarketWatch 指数和个股路径不同：`/investing/index/spx` vs `/investing/stock/aapl`

## 如何处理例外/特殊链接

### 1. 链接覆盖

如果某个资产的某个链接不符合通用模板，在资产文件里加 `link_overrides`：

```json
{
  "symbols": { "tradingview": "SSE:000001" },
  "link_overrides": {
    "tradingview": {
      "symbol_page": { "url": "https://www.tradingview.com/symbols/SSE-000001/custom/" }
    }
  }
}
```

### 2. 完全自定义链接

如果某个 provider 根本没有统一规则（比如 `investing.com`），`providers.json` 里把它的 `symbol_key` 设为 `null`，默认不生成。需要时在资产文件里显式写 `links`。

例如 `catalog/assets/cn/stock/kweichow_moutai.json`：

```json
{
  "id": "cn_stock_kweichow_moutai",
  "symbols": {
    "tradingview": "SSE:600519",
    "yahoo": "600519.SS",
    "google": "600519:SHA"
  },
  "links": {
    "jump": [
      {
        "provider": "investing",
        "kind": "quote_or_chart",
        "url": "https://www.investing.com/equities/kweichow-moutai"
      }
    ],
    "embed": [],
    "crawl": []
  }
}
```

## 从旧版完整 JSON 迁移

如果你有一个旧的完整 `market_sources_catalog.json`，可以一键拆分成小文件：

```bash
python catalog/migrate.py
```

该脚本会：

1. 按 `region/market_group/asset_id.json` 拆分；
2. 丢弃能由新模板自动生成的链接（tradingview/yahoo/google/新浪/东方财富/雪球/同花顺/富途/MarketWatch/StockTwits/Stooq/CoinMarketCap/Binance）；
3. 保留无法自动生成的链接（主要是 investing.com 和自定义 provider）；
4. 自动备份原 `assets/` 目录。

迁移完成后，再运行 `python catalog/build.py` 生成完整 catalog。

## 构建

```bash
python catalog/build.py
```

默认输出到 `catalog/dist/market_sources_catalog.json`，不会覆盖项目根目录的原文件。

```bash
# 指定输出路径
python catalog/build.py --output catalog/dist/catalog.json

# 不备份
python catalog/build.py --no-backup
```

## 设计取舍（为什么这样分）

1. **按 region + market_group 分目录**：符合自然业务维度，找文件直观。
2. **资产文件最小化**：避免 90% 的重复配置（links/widgets）。
3. **模板生成派生数据**：新增资产只需写 symbols，链接自动生成。
4. **保留覆盖能力**：用 `link_overrides` / `links` 处理例外，避免模板过度复杂。
5. **不引入 YAML/TOML**：继续用 JSON，保持和原项目一致，降低迁移成本。
6. **不引入数据库**：当前量级文件系统足够，且 diff/版本控制友好。
