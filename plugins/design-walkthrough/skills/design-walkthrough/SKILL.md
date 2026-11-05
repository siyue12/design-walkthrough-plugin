---
name: design-walkthrough
description: 读取 Figma 设计稿与交互说明，对比前端开发页面，找出布局/交互问题并截图，人工审核后通过飞书 CLI 登记到多维表格。Use when the user asks for design walkthrough, 走查, Figma 与前端页面对比, 登记走查问题, or wants to record UI issues into Feishu Bitable.
---

# 设计走查登记

把 Figma 设计稿/交互说明和前端页面做对比，找出**布局**和**交互逻辑**问题，截图，人工审核后写入飞书多维表格。

## 0. 前置检查

1. **飞书 CLI**
   ```bash
   LARK="$HOME/.zcode/tools/lark-cli/node_modules/.bin/lark-cli"
   "$LARK" auth status
   "$LARK" base +table-list --base-token REMOVED
   ```
   - `auth status` 里 `identities.user.available` 必须为 true。
   - 如果 `needs_refresh`，调用一次 base 命令会自动刷新；失败则运行 `"$LARK" auth login`，把 QR/链接给用户扫码。
   - 表结构：Base `REMOVED`，Table `REMOVED`（走查问题登记）。

2. **Figma**
   - 用 Figma MCP：`mcp__figma-local__get_metadata` / `mcp__figma-local__get_screenshot`。
   - 没有明确页面/Frame 时先问用户，不要猜。
   - 走查阶段不需要 `get_design_context`；只有要生成代码时才加载 `figma-design-to-code`。

3. **浏览器**
   - 先加载 `browser-use:control-browser` 技能，按它的 bootstrap 初始化。
   - 优先用 ZCode 内置浏览器（IAB）；内网页面如登录/证书问题，让用户在 IAB 里登录，或让用户提供截图。
   - **不要关闭、重开或操作用户自己的 Chrome 标签页**；不要把用户踢下线。

4. **输入**
   缺少以下任一项就问：
   - Figma 页面/Frame（名称或 node id）
   - 前端 URL
   - 版本/批次（默认 `v1.0 走查第1轮`）
   - 走查范围（页面/模块；默认当前页面）

## 1. 读取 Figma 设计稿与交互说明

1. 对目标 Frame 调 `get_metadata`，拿到节点树、尺寸、文案、组件、状态。
2. 对目标 Frame 调 `get_screenshot`，看整体布局和状态。
3. 如果 Figma 里有「流程設計」「交互说明」「批注」页面或文字节点，一并读取；交互说明以文字节点/批注为准。
4. 记录：
   - 页面尺寸（例如 1440×914）
   - 顶部导航、Tab、搜索、分类、按钮网格的数量和位置
   - 交互状态：默认态、搜索态、空状态、展开/收起、hover/focus/disabled
   - 设计注释（例如「默认显示收起」「内容超出容器」）
5. **只看布局和交互逻辑**；不要拿 Figma 里的业务字段去要求前端保持一致，业务字段以前端页面为准。

## 2. 打开前端页面

1. 用 browser-use 打开用户给的 URL。
2. `tab.setViewportSize({ width: 1440, height: 914 })`，与 Figma Frame 对齐；如果 Figma 不是 1440，按 Figma 尺寸设置。
3. `waitForLoadState({ state: "domcontentloaded" })`，必要时等 1~2 秒让 SPA 渲染。
4. 先 `domSnapshot()` 理解结构；需要视觉判断时再 `screenshot()`。
5. 如果页面需要登录：
   - 让用户在 IAB 里完成登录；登录后继续。
   - 如果 IAB 打不开内网/证书错误，停止并让用户提供截图或可登录的测试环境。
   - 不要复制用户 Chrome 的 cookie/token，也不要读取用户浏览器存储。

## 3. 对比清单

按下面顺序逐项对比，只记录**前端实现与设计稿/交互说明不一致**的问题：

### 布局

- 页面整体尺寸、内容区宽度、左右留白
- 顶部导航：顺序、数量、名称、换行、截断、图标
- Tab：顺序、选中态、关闭按钮、内容对应关系
- 搜索区：位置、宽度、占位符、图标、清除按钮
- 分类区块：标题、计数、顺序、高度、间距
- 按钮网格：列数、按钮宽度、间距、文字截断、最后一行对齐
- 内容溢出：横向滚动、纵向滚动、被裁切、遮挡
- 响应式：浏览器宽度变化时是否折行/溢出（至少看 1440 和当前窗口宽度）
- 空状态/加载态/错误态

### 交互

- Tab 切换是否正常，选中态是否明显
- 搜索：输入、过滤、计数、空结果、清除、简繁/大小写匹配
- 分类展开/收起：默认状态、箭头、点击区域
- hover / focus-visible / disabled / loading
- 弹窗/抽屉：打开、关闭、遮罩、Esc、焦点
- 按钮点击后的反馈、二次确认（只观察，不执行破坏性操作）
- 返回/面包屑/滚动位置

### 不计入问题

- 业务字段名称、业务数据、接口字段、权限差异
- 文案业务含义（但简繁混用、错别字、截断算问题）
- 纯主观审美偏好（除非与设计规范明显冲突）

## 4. 截图与脱敏

每个问题至少一张图，命名：

```text
.walkthrough/shots/<YYYY-MM-DD>/<page-slug>-<nn>-<issue-slug>.png
```

截图方式：

1. 用 `playwright.evaluate` 拿到问题元素的 `getBoundingClientRect()`。
2. 注入一个临时红色描边层（`position: fixed`、`border: 2px solid #ff4d4f`、`pointer-events: none`、高 z-index），截图后移除。
3. 用 `tab.screenshot({ clip: { x, y, width, height } })` 截问题区域；如果问题在视口外，先滚动到可见。
4. 保存：
   ```js
   const { writeFileSync, mkdirSync } = await import("node:fs");
   mkdirSync(dir, { recursive: true });
   writeFileSync(path, Buffer.from(await tab.screenshot({ clip })));
   ```

**脱敏规则（必须）**：

- 截图中不能出现客户姓名、证件号、电话、账户号、地址等个人信息。
- 优先截取不包含客户数据的区域（导航、Tab、搜索、按钮网格、空状态）。
- 无法避开时，用黑色矩形覆盖敏感区域再截图；不要先上传再考虑。
- 如果无法确认是否敏感，先问用户。

## 5. 生成草稿并人工审核

把问题写成 `.walkthrough/reports/<YYYY-MM-DD>-<page-slug>-draft.json`：

```json
{
  "issues": [
    {
      "title": "互联网服务标题 22 项但设计稿只有 18 个按钮",
      "module": "CSR 工作台 / 互联网服务",
      "types": ["视觉还原"],
      "severity": "P0",
      "description": "1. 分类标题显示 22 项，但 Figma 只放了 18 个按钮（6×3），缺 4 个。\n2. 区块高度只容纳 3 行，第 4 行放不下。\n3. 建议补齐 4 个按钮并调整高度，或修正计数。",
      "version": "v1.0 走查第1轮",
      "notes": "Figma node 1095:85178；前端选择器 .internet-service-grid",
      "screenshots": ["/绝对路径/.walkthrough/shots/2026-11-04/csr-01-internet-22.png"]
    }
  ]
}
```

### 问题描述格式（必须）

写入飞书「问题描述」前，必须整理成**序号分点 + 精简要点**：

- 用 `1. 2. 3.` 分点，2~4 点为宜，最多 5 点。
- 每点只写一个核心事实；单点建议 ≤60 字，最多 100 字。
- 不要写长段落、不要重复背景、不要把 Figma 和前端的所有细节都抄进去。
- 推荐结构：`1. 现象` → `2. 影响/复现` → `3. 期望`。
- 脚本会自动编号、去掉原有项目符号，并对超长内容截断；但语义提炼仍由你完成。

示例：

```text
1. 分类标题显示 22 项，但 Figma 只有 18 个按钮，缺 4 个。
2. 区块高度只容纳 3 行，第 4 行放不下。
3. 建议补齐 4 个按钮并调整高度，或修正计数。
```

字段规则：

- `title`：一句话，能独立看懂；不要写「样式问题」这种空话。
- `module`：页面/模块，例如 `CSR 工作台 / 搜索态`。
- `types`：`视觉还原` / `交互体验` / `文案` / `功能缺陷` / `兼容适配` / `性能` / `其他`，可多选。
- `severity`：`P0` / `P1` / `P2` / `P3`；脚本会映射成 `P0-致命` 等。
- `description`：必须按 `1. 2. 3.` 分点、精简成 2~4 个核心要点，不要写长段落；详见上面的「问题描述格式」。
- `notes`：放 Figma node、前端选择器、设计注释等证据。
- `screenshots`：本地绝对路径；没有截图的问题先不要提交。

在聊天里给用户一张审核表：

| # | 模块 | 问题 | 类型 | 严重程度 | 截图 |
|---|---|---|---|---|---|

明确问用户：**哪些要登记、哪些要改优先级/措辞、哪些不登记**。用户没有明确说「登记/确认」之前，不要执行写入。

## 6. 写入飞书

1. 先 dry-run：
   ```bash
   PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
   node "$PLUGIN_ROOT/scripts/register-walkthrough.mjs" \
     --input .walkthrough/reports/2026-11-04-csr-draft.json \
     --dry-run
   ```
   把将要写入的 payload 和截图路径给用户看。

2. 用户确认后写入：
   ```bash
   node "$PLUGIN_ROOT/scripts/register-walkthrough.mjs" \
     --input .walkthrough/reports/2026-11-04-csr-draft.json \
     --yes
   ```
   - 脚本会先查重；同名问题默认跳过，确认要重复登记才加 `--allow-duplicate`。
   - 创建记录后自动上传截图；上传失败会返回 `recordId` 和 `uploadError`，用同一个 recordId 重试，不要重建记录。
   - 返回 `recordId` / `recordUrl` / `upload`，把链接给用户。

3. 只登记用户确认的问题：可以直接编辑 draft JSON，删掉不登记的条目，再执行。

## 7. 后续更新

```bash
# 改状态
node "$PLUGIN_ROOT/scripts/register-walkthrough.mjs" \
  --update-record recXXXXXXXX \
  --status 待验证 --yes

# 加负责人/修复说明/复验结果
node "$PLUGIN_ROOT/scripts/register-walkthrough.mjs" \
  --update-record recXXXXXXXX \
  --assignee ou_xxx \
  --fix-note "已按设计稿调整" \
  --verify 通过 --yes
```

默认仍是 dry-run；不加 `--yes` 只打印 payload。

## 8. 硬约束

- **不自动写入**：没有用户明确确认，不允许 `--yes`。
- **问题描述必须分点精简**：写入前整理成 `1. 2. 3.`，2~4 个核心要点；长段落会被脚本截断。
- **不碰业务字段**：业务字段以前端页面为准；只比较布局和交互。
- **不碰客户隐私**：截图前脱敏；不确定就问。
- **不做破坏性操作**：不提交、不删除、不发布、不审批；只做浏览/切换/搜索/hover/focus。
- **不动用户浏览器**：不关闭/重开用户 Chrome 标签页，不读取用户 cookie/localStorage。
- **不猜**：Figma Frame、前端 URL、版本/批次不明确就问。
- **字段自检**：`register-walkthrough.mjs` 会读 `+field-list` 校验字段和选项；失败时按报错修正，不要绕过。
- **示例记录**：表里已有 `NO.001` 示例记录，未经确认不删除、不修改。

## 9. 输出格式

结束时给用户：

```text
本次走查：
- Figma：<page/frame>
- 前端：<url>
- 视口：1440×914
- 候选问题：N 条（P0 x，P1 x，P2 x，P3 x）

已登记：
- NO.xxx  <问题标题>  <recordUrl>
- ...

未登记/待确认：
- ...
```

如果页面打不开、登录失败、字段不匹配，明确说明卡点和下一步，不要用「已完成」概括。
