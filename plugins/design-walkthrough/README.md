# 设计走查登记插件

读取当次 Figma 设计稿与交互说明建立「设计基线」，逐条到前端页面取「实现值」，差集登记为问题；设计稿缺失的规则先问用户补充，补不了则登记为「待确认项」。问题截图后经人工审核，通过飞书 CLI 写入多维表格。

## 目录

```text
plugins/
  marketplace.json                 # 本地测试市场清单
  design-walkthrough/
    .zcode-plugin/plugin.json      # 插件清单
    commands/走查.md               # /走查 命令
    skills/design-walkthrough/     # 走查方法与飞书写入流程
    scripts/register-walkthrough.mjs
    config/feishu.json             # 飞书 Base/Table/字段映射
    examples/sample-draft.json     # dry-run 示例
```

## 飞书配置

- Base：`REMOVED`
- Table：`REMOVED`（走查问题登记）
- 待确认表：「待确认项」（同一 Base；表名和字段 schema 在 `config/feishu.json` 的 `feishu.pending`）
- 「解决方案截图」字段由人工上传方案图，插件不写入、不覆盖。
- CLI：`~/.zcode/tools/lark-cli/node_modules/.bin/lark-cli`
- 登录态：`lark-cli auth status`；失效时 `lark-cli auth login` 扫码。

`config/feishu.json` 已按当前表结构配置。字段名或选项如果被改，脚本会在 `+field-list` 自检时报错。

问题登记清单固定按目标表的实际字段顺序输出（取 `GET /open-apis/bitable/v1/apps/<base>/tables/<table>/fields` 的返回顺序，不用 `+field-list` 的随机顺序），顺序记录在 `config/feishu.json` 的 `feishu.fieldOrder`；dry-run 的 payload 也按该顺序打印。

## 使用

1. 在插件市场添加本地市场：`/Users/tim/Desktop/设计走查登记表/plugins`
2. 安装「设计走查登记」。
3. 新建任务，输入 `/走查`，按提示给 Figma 页面/Frame、前端 URL、版本/批次。
4. 走查先读 Figma 生成设计基线，逐条到前端取实现值；基线缺失的规则会先问你补充。
5. 走查完成后先审核问题清单与待确认项；确认后才写入飞书。

也可以直接运行登记脚本：

```bash
PLUGIN_ROOT="/Users/tim/Desktop/设计走查登记表/plugins/design-walkthrough"

# dry-run：只校验字段、查重、打印将要写入的 payload
node "$PLUGIN_ROOT/scripts/register-walkthrough.mjs" \
  --input "$PLUGIN_ROOT/examples/sample-draft.json" \
  --dry-run

# 真正写入（必须人工确认后）
node "$PLUGIN_ROOT/scripts/register-walkthrough.mjs" \
  --input .walkthrough/reports/2026-11-10-list-draft.json \
  --yes

# 单独查找/创建「待确认项」表（--yes 时才真正建表）
node "$PLUGIN_ROOT/scripts/register-walkthrough.mjs" \
  --ensure-pending-table --yes
```

## 草稿格式

```json
{
  "issues": [
    {
      "title": "问题标题",
      "module": "页面/模块",
      "baselineRef": "B01 / node 12:34",
      "types": ["交互体验"],
      "severity": "P1",
      "description": "现象：\n1. ...\n2. ...\n\n期望：\n1. ...\n2. ...",
      "version": "v1.0 走查第1轮",
      "notes": "Figma node / 前端选择器 / 证据",
      "screenshots": ["/绝对路径/问题截图.png"]
    }
  ],
  "pending": [
    {
      "title": "缺失的规则",
      "module": "页面/模块",
      "missingRule": "设计稿未定义的具体规则",
      "impact": "影响的验收点",
      "baselineRef": "node 12:40",
      "version": "v1.0 走查第1轮",
      "notes": "询问记录",
      "screenshots": []
    }
  ]
}
```

`severity` 支持 `P0`/`P1`/`P2`/`P3`，按下面「严重程度判定」定级，脚本会映射成 `P0-致命` 等；`types` 必须使用表里已有的选项。

多个问题合并成一条记录时，必须属于同一组件/模块或逻辑相关；把 `description` 写成对应数量的「现象」点，`screenshots` 按点顺序放多张红框截图，最多 3 张（与 1~3 个现象点一一对应）。

### 严重程度判定

只对已确认的基线偏差定级，按「交互规则实现 × 影响范围」两轴判断：

| 影响范围 | 关键交互规则未实现/错误 | 非关键规则实现偏差 | 仅细节/文案/视觉差异 |
|---|---|---|---|
| 核心流程 / 全量用户 | P0-致命 | P1-严重 | P2-一般 |
| 主要路径 / 主要角色 | P1-严重 | P2-一般 | P3-建议 |
| 局部 / 特定状态 / 边缘 | P2-一般 | P3-建议 | P3-建议 |

P0 只给主流程阻断、关键结果错误或关键数据丢失；严重程度 ≠ 修复优先级。完整规则见 `SKILL.md` §6「严重程度判定」。

### 问题描述格式

写入飞书前，脚本会自动把「问题描述」整理成固定两段：

```text
现象：
1. ...
2. ...
3. ...

期望：
1. ...
2. ...
3. ...
```

- 每段 1~3 点，单点建议 ≤60 字，最多 100 字。
- 每点一个核心事实；不要写长段落。
- 只给一串要点时，脚本会把「建议/应该/补齐/调整」类要点分到期望段，并补一个默认期望。
- 可在 `config/feishu.json` 的 `walkthrough.description` 调整 `maxPointsPerSection` / `maxCharsPerPoint` / `maxTotalChars`。

## 安全与边界

- 基线只来自当次 Figma 节点树/截图/交互说明；不拿历史记录、通用清单、其他系统标准当验收依据。
- 基线缺失先问用户补充规则；用户也补不了，只登记到「待确认项」表，不判缺陷、不定严重程度。
- 每条问题必须带 `baselineRef`（B 编号 + node id），否则不允许登记。
- 默认 dry-run，只有 `--yes` 才写入。
- 创建记录后单独上传截图；上传失败用同一个 `recordId` 重试，不重建记录。
- 每个问题点都要有独立红框截图，截取当前存在差异的前端页面；不要用 Figma 稿、元素小图或一张图框多个问题点代替。
- 多个问题可合并登记在一行，但仅限同一组件/模块或逻辑相关的问题；A 模块和 B 模块的无关联问题不能合并。每个问题点仍各配一张截图；合并后「现象」点与截图按顺序一一对应，最多 3 点。
- 走查地址默认视为测试环境：提交、保存、删除、发布、启用停用、审批等写操作直接执行并记录结果，不需要逐项确认，不只开到弹窗。
- 用户明确说是生产环境时，退回只读，不执行写操作。
- 写操作只限走查地址同源页面；可操作既有测试数据；能撤销的撤销，不能撤销的在结果里列明。
- 截图不需要脱敏（测试环境是脏数据/非生产数据）；表单填什么都可以，非生产环境无影响。
- 不读取用户 Chrome 的 cookie/localStorage；写操作仅限测试环境的同源页面。

## 排障

- `lark-cli` 找不到：确认 `~/.zcode/tools/lark-cli/node_modules/.bin/lark-cli` 存在，或在 `config/feishu.json` 改 `larkCliPath`。
- 登录失效：运行 `lark-cli auth login`，扫码后重试。
- 字段不匹配：脚本会打印现有字段和可选值；按提示修改 `config/feishu.json` 或飞书表字段。
- 截图上传失败：检查文件格式（PNG/JPG 等）、路径是否存在；用返回的 `recordId` 重新上传。
- 「待确认项」表不存在：`--yes` 写入时脚本会按 `feishu.pending.tableFields` 自动建表；也可先跑 `--ensure-pending-table --yes` 预建，再把返回的 `tableId` 回填到 `feishu.pending.tableId`。
