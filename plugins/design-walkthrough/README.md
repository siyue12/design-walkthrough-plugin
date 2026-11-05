# 设计走查登记插件

读取 Figma 设计稿与交互说明，对比前端开发页面，找出布局/交互问题并截图，人工审核后通过飞书 CLI 写入多维表格。

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
- CLI：`~/.zcode/tools/lark-cli/node_modules/.bin/lark-cli`
- 登录态：`lark-cli auth status`；失效时 `lark-cli auth login` 扫码。

`config/feishu.json` 已按当前表结构配置。字段名或选项如果被改，脚本会在 `+field-list` 自检时报错。

## 使用

1. 在插件市场添加本地市场：`/Users/tim/Desktop/设计走查登记表/plugins`
2. 安装「设计走查登记」。
3. 新建任务，输入 `/走查`，按提示给 Figma 页面/Frame、前端 URL、版本/批次。
4. 走查完成后先审核问题清单；确认后才写入飞书。

也可以直接运行登记脚本：

```bash
PLUGIN_ROOT="/Users/tim/Desktop/设计走查登记表/plugins/design-walkthrough"

# dry-run：只校验字段、查重、打印将要写入的 payload
node "$PLUGIN_ROOT/scripts/register-walkthrough.mjs" \
  --input "$PLUGIN_ROOT/examples/sample-draft.json" \
  --dry-run

# 真正写入（必须人工确认后）
node "$PLUGIN_ROOT/scripts/register-walkthrough.mjs" \
  --input .walkthrough/reports/2026-11-04-csr-draft.json \
  --yes
```

## 草稿格式

```json
{
  "issues": [
    {
      "title": "问题标题",
      "module": "页面/模块",
      "types": ["交互体验"],
      "severity": "P1",
      "description": "现象：\n1. ...\n2. ...\n\n期望：\n1. ...\n2. ...",
      "version": "v1.0 走查第1轮",
      "notes": "Figma node / 前端选择器 / 证据",
      "screenshots": ["/绝对路径/问题截图.png"]
    }
  ]
}
```

`severity` 支持 `P0`/`P1`/`P2`/`P3`，脚本会映射成 `P0-致命` 等；`types` 必须使用表里已有的选项。

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

- 默认 dry-run，只有 `--yes` 才写入。
- 创建记录后单独上传截图；上传失败用同一个 `recordId` 重试，不重建记录。
- 截图前必须遮挡客户姓名、证件号、电话、账户号等敏感信息。
- 不做提交、删除、发布等破坏性操作。
- 不读取用户 Chrome 的 cookie/localStorage，不操作业务数据。

## 排障

- `lark-cli` 找不到：确认 `~/.zcode/tools/lark-cli/node_modules/.bin/lark-cli` 存在，或在 `config/feishu.json` 改 `larkCliPath`。
- 登录失效：运行 `lark-cli auth login`，扫码后重试。
- 字段不匹配：脚本会打印现有字段和可选值；按提示修改 `config/feishu.json` 或飞书表字段。
- 截图上传失败：检查文件格式（PNG/JPG 等）、路径是否存在；用返回的 `recordId` 重新上传。
