# Market Source Catalog Engine

纯 Python 标准库后端 + 原生 JS 前端，用来维护、浏览金融市场资产目录。

## 项目结构

```
.
├── app.py                              # 后端：静态文件 + API
├── static/                             # 前端资源
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── catalog/                            # 分体式配置（推荐维护方式）
│   ├── _meta/
│   │   ├── providers.json              # provider URL/widget 模板
│   │   ├── regions.json
│   │   └── market_groups.json
│   ├── assets/                         # 按 region/market_group 拆分的小 JSON
│   ├── build.py                        # 生成完整 catalog
│   └── dist/market_sources_catalog.json # 生成产物
└── market_sources_catalog.json         # 旧版完整 catalog（保留兼容）
```

## 运行

```bash
# 使用分体式配置生成的 catalog（推荐）
python app.py

# 或指定旧版完整 catalog
python app.py --catalog market_sources_catalog.json --port 8787
```

打开：

```text
http://localhost:8787
```

Windows 可以双击 `scripts/start.bat`；Linux/macOS 可运行 `scripts/start.sh`（注意启动脚本默认仍指向旧 catalog，可按需修改）。

## 前端功能

- 响应式布局：桌面端三栏，移动端抽屉/全屏详情
- 搜索：name / symbol / tag / note / market
- 筛选：region、market_group、provider
- 资产卡片：显示名称、代码、分类、tags
- 详情面板：一键打开各 provider 链接、TradingView widget 实时预览
- 刷新数据、导出 JSON

内置数据源包括：TradingView、Yahoo Finance、Google Finance、Investing、Stooq、CoinGecko、Frankfurter，以及国内可访问的 **新浪财经、东方财富、雪球、同花顺、富途**，美股的 **MarketWatch、StockTwits**，加密货币的 **CoinMarketCap、Binance**。

## 后端 API

- `GET /` → `static/index.html`
- `GET /static/*` → 静态资源
- `GET /api/catalog` → 完整 catalog JSON
- `GET /api/assets` → 拍平后的资产数组
- `GET /api/stats` → 统计信息
- `GET /api/export` → 下载 catalog JSON
- `GET /api/reload` → 重新加载 catalog
- `POST /api/catalog` → 保存 catalog
- `POST /api/validate` → 校验 catalog

## 维护 catalog（推荐方式）

1. 在 `catalog/assets/` 下按 `region/market_group/` 添加或修改资产 JSON；
2. 运行 `python catalog/build.py` 生成 `catalog/dist/market_sources_catalog.json`；
3. 启动 `python app.py` 即可在 dashboard 中看到更新。

这样日常只需维护小文件，链接和 widget 配置由模板自动生成。

## 从旧版单一 JSON 迁移

如果你已有旧版完整的 `market_sources_catalog.json`，可以一键拆分：

```bash
python catalog/migrate.py     # 拆分到 catalog/assets/
python catalog/build.py       # 重新生成完整 catalog
python app.py                 # 启动 dashboard
```

迁移脚本会自动备份原 `catalog/assets/`，并丢弃可由新模板自动生成的链接，只保留 investing.com 等无规则链接。

## 使用旧版单一 JSON（不迁移）

如果你暂时不想迁移，直接把完整 `market_sources_catalog.json` 放到项目根目录，然后：

```bash
python app.py --catalog market_sources_catalog.json
```

新旧格式在 API 层完全兼容。
