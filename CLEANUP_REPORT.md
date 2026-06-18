# 代码目录清理报告

## 变更概览

为消除根目录下脚本的混乱，新建了两个目录并按用途分类：

- `scripts/`：存放**可复用**的项目级脚本。
- `temp/`：预留目录，存放**一次性/临时**脚本或实验文件。

## 移动清单

| 原路径 | 新路径 | 移动理由 |
|---|---|---|
| `start.bat` | `scripts/start.bat` | 项目启动脚本，长期复用；与 `app.py` 分离后根目录更清爽。 |
| `start.sh` | `scripts/start.sh` | 同上，跨平台启动入口。 |

## 留在原处的文件/目录及理由

| 路径 | 说明 |
|---|---|
| `app.py` | 主应用入口，不是“脚本”，应保留在项目根目录。 |
| `catalog/build.py` | catalog 域专用构建工具，与 `catalog/_meta/`、`catalog/assets/` 强耦合；留在 `catalog/` 内符合“按业务域组织”的约定。 |
| `catalog/add_asset.py` | catalog 域专用 CLI 工具，依赖 `catalog/build.py` 与 `catalog/_meta/`；与构建工具放在一起便于维护。 |
| `market_sources_catalog.json` | 旧版完整 catalog 备份文件，按 AGENTS.md 约定保留在根目录作为兼容。 |

## 路径同步修改

因 `start.bat` / `start.sh` 移动到了 `scripts/`，脚本内部对工作目录的引用需要指向父目录：

- `scripts/start.bat`：`cd /d "%~dp0"` → `cd /d "%~dp0\.."`
- `scripts/start.sh`：`cd "$(dirname "$0")"` → `cd "$(dirname "$0")/.."`

文档同步更新：

- `README.md`：启动说明改为指向 `scripts/start.bat` 与 `scripts/start.sh`。
- `AGENTS.md`：目录树增加 `scripts/` 与 `temp/`；构建流程示例补充说明可用启动脚本；移除已不存在的 `migrate.py` 条目。

## 清理的生成文件

- 删除了根目录及 `catalog/` 下的 `__pycache__/` 目录（Python 字节码缓存，已被 `.gitignore` 忽略，不应纳入版本控制）。

## 当前目录结构（关键部分）

```text
.
├── app.py                    # 主应用
├── catalog/
│   ├── add_asset.py          # catalog 域 CLI 工具
│   ├── build.py              # catalog 构建工具
│   ├── assets/               # 资产小文件
│   └── dist/                 # 生成产物（gitignore）
├── scripts/
│   ├── start.bat             # Windows 启动脚本
│   └── start.sh              # Linux/macOS 启动脚本
├── temp/                     # 临时/一次性脚本（当前为空）
├── static/                   # 前端
├── AGENTS.md
├── README.md
└── market_sources_catalog.json
```

## 使用建议

- 以后新增**一次性调试脚本、数据抓取实验、临时迁移工具**等，先放入 `temp/`，用完后及时删除或归档。
- 新增**项目级可复用脚本**（如批量导入、备份、部署脚本）放入 `scripts/`，并在 `README.md` 或 `AGENTS.md` 中补充使用说明。
- `catalog/` 内的工具保持与 catalog 业务域紧密绑定，不随意迁移到 `scripts/`，避免路径与导入关系复杂化。
