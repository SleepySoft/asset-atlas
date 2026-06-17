# AGENTS.md — Global Asset Atlas

> 本文档记录项目背景、架构决策和协作约定，供后续开发/迁移时参考。
> 项目当前定位：**全球资产数据的分类索引**（原名 Market Catalog Engine）。

---

## 1. 项目定位

一个结构化的全球金融市场资产目录系统：

- 按 **地区（region）** 和 **分类（market_group）** 组织资产；
- 每个资产维护一组核心符号（symbols）；
- 通过 provider 模板自动生成多个数据源的跳转链接、可嵌入 widget、可抓取入口；
- 提供 Web Dashboard 用于浏览、搜索、筛选和预览。

---

## 2. 演进历史（必须了解）

### 阶段 0：单一 JSON

- 文件：`market_sources_catalog.json`（原约 6000 行）
- 问题：所有链接和 widget 配置重复存储，手动维护困难。

### 阶段 1：分体式配置

- 新增 `catalog/` 目录；
- 资产拆分为 `catalog/assets/{region}/{market_group}/{asset_id}.json`；
- 元数据集中放在 `catalog/_meta/`。

### 阶段 2：模板化生成

- `catalog/_meta/providers.json` 定义 provider 的 URL/widget 模板；
- `catalog/build.py` 根据 `symbols` 自动推导链接；
- 消除 90% 重复配置。

### 阶段 3：扩展数据源

新增国内可访问数据源：新浪财经、东方财富、雪球、同花顺、富途；
新增国际/加密货币：MarketWatch、StockTwits、CoinMarketCap、Binance。

### 阶段 4：迁移旧数据

- 新增 `catalog/migrate.py`；
- 将旧版完整 JSON 拆分为新结构，保留 investing.com 等无规则链接。

### 阶段 5：Dashboard 改造

- 后端 `app.py` 改为静态文件服务器 + API；
- 前端拆分为 `static/index.html`、`css/style.css`、`js/app.js`；
- 响应式布局，支持搜索/筛选/Widget 预览。

### 阶段 6：中文标签

- `regions.json` 增加 `name_zh`；
- `market_groups.json` 增加 `label` / `label_zh`；
- Dashboard 按分类分组显示，使用中文分类名。

---

## 3. 目录结构

```
.
├── app.py                              # 后端：静态文件 + API
├── static/                             # 前端
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── catalog/                            # 分体式配置（核心维护区）
│   ├── _meta/
│   │   ├── providers.json              # provider 模板、角色、说明
│   │   ├── regions.json                # region 短代码映射 + 中文名
│   │   └── market_groups.json          # 分类映射 + 中英文标签
│   ├── assets/                         # 资产小文件
│   │   ├── cn/index/                   # 中国指数
│   │   ├── cn/stock/                   # 中国个股
│   │   ├── hk/index/, hk/stock/        # 香港
│   │   ├── us/index/, us/stock/        # 美国
│   │   ├── jp/, kr/, tw/, uk/          # 其他市场
│   │   └── global/commodity/fx/crypto/ # 全球市场
│   ├── build.py                        # 生成完整 catalog
│   ├── migrate.py                      # 旧 JSON → 新结构
│   ├── README.md                       # catalog 维护说明
│   └── dist/market_sources_catalog.json # 生成产物
├── market_sources_catalog.json         # 旧版完整 catalog（保留兼容）
├── start.bat / start.sh
└── README.md
```

---

## 4. 核心约定

### 4.1 资产文件最小化

每个资产文件只保留唯一信息：

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

- `region`、`market_group`、`asset_class` 从文件路径推断；
- `links` / `embed` 由 `providers.json` 模板自动生成；
- 只保留无法自动生成的链接（如 investing.com）。

### 4.2 Provider 模板占位符

常用占位符：

| 占位符 | 含义 | 示例 |
|---|---|---|
| `{symbol}` | 原始 symbol | `SSE:000001` |
| `{symbol_escaped}` | URL 编码 | `SSE%3A000001` |
| `{symbol_dash}` | `:` 变 `-` | `SSE-000001` |
| `{symbol_sina}` | 新浪财经 | `sh000001` |
| `{symbol_eastmoney}` | 东方财富 | `zs000001` / `sh600519` |
| `{symbol_xueqiu}` | 雪球 | `SH000001` |
| `{symbol_10jqka}` | 同花顺 | `600519` |
| `{symbol_futu}` | 富途 | `00700-HK` / `AAPL-US` |
| `{symbol_marketwatch}` | MarketWatch | `spx` / `aapl` |
| `{symbol_marketwatch_path}` | MarketWatch 路径 | `index` / `stock` |

模板缺失占位符时，`build.py` 会自动跳过该链接，不会报错。

### 4.3 构建流程

```bash
# 日常维护
python catalog/build.py          # 生成 catalog/dist/market_sources_catalog.json
python app.py                    # 启动 dashboard

# 从旧版迁移
python catalog/migrate.py        # 拆旧 JSON 到 catalog/assets/
python catalog/build.py
python app.py
```

---

## 5. 后端 API

- `GET /` → `static/index.html`
- `GET /static/*` → 静态资源
- `GET /api/catalog` → 完整 catalog（含 region_zh / label_zh）
- `GET /api/assets` → 拍平后的资产数组
- `GET /api/stats` → 统计信息
- `GET /api/export` → 下载 JSON
- `GET /api/reload` → 重新加载
- `POST /api/catalog` → 保存 catalog
- `POST /api/validate` → 校验 catalog

---

## 6. 前端行为

- 加载 `/api/catalog`，拍平资产；
- 左侧筛选：地区、分类、provider；
- 搜索：名称、代码、tag、note、market；
- 主区域按 **分类分组** 显示资产卡片；
- 右侧详情面板：信息、跳转链接、可抓取链接、TradingView widget 预览；
- 桌面端三栏，移动端抽屉/全屏详情。

---

## 7. 设计取舍

| 决策 | 理由 |
|---|---|
| 继续用 JSON，不引入 YAML/TOML | 降低迁移成本，与旧格式一致 |
| 文件系统而非数据库 | 当前量级够用，diff/版本控制友好 |
| 模板生成派生链接 | 消除重复，新增资产只需写 symbols |
| `link_overrides` / 显式 `links` 处理例外 | 避免模板系统过度复杂 |
| 地区 + 分类两级目录 | 符合自然业务维度，直观 |
| 前后端分离 | 前端可独立维护，不再把 HTML 塞 Python 字符串 |

---

## 8. 已知限制

- Dashboard 目前只读，没有提供编辑小 JSON 的 UI；
- Widget 预览仅支持 TradingView 嵌入 widget；
- 部分 provider（如 investing.com）URL 无统一规则，需逐个维护。

---

## 9. 迁移注意事项

如果你要把本项目迁移到新目录：

1. 保留 `catalog/assets/` 和 `catalog/_meta/`；
2. 在新位置运行 `python catalog/build.py`；
3. 用 `python app.py` 启动；
4. 旧版 `market_sources_catalog.json` 仅作备份，日常维护以 `catalog/` 为准。
