#!/usr/bin/env node
/**
 * 飞书走查登记写入脚本。
 *
 * 默认 dry-run，只读取字段和查重并打印将要写入的内容；
 * 只有显式传入 --yes 才会创建记录/上传截图/更新记录。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, "..");
const configPath = join(pluginRoot, "config", "feishu.json");

const SEVERITY_ALIASES = {
  P0: "P0-致命",
  P1: "P1-严重",
  P2: "P2-一般",
  P3: "P3-建议",
};

const STATUS_ALIASES = {
  待修复: "待处理",
  待处理: "待处理",
  修复中: "处理中",
  处理中: "处理中",
  待验收: "待验证",
  待验证: "待验证",
  已验收: "已关闭",
  已关闭: "已关闭",
};

const VERIFY_ALIASES = {
  待复验: "待复验",
  通过: "通过",
  不通过: "不通过",
};

const SCREENSHOT_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".jfif",
  ".exif",
  ".tif",
  ".tiff",
  ".bpg",
  ".heic",
]);

function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~") ? join(process.env.HOME || "", p.slice(1)) : p;
}

function loadConfig() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const feishu = config.feishu || {};
  const required = ["baseToken", "tableId", "larkCliPath", "fieldNames"];
  for (const key of required) {
    if (!feishu[key]) throw new Error(`config/feishu.json 缺少 feishu.${key}`);
  }
  const pending = feishu.pending || {};
  for (const key of ["tableName", "tableFields", "fieldNames"]) {
    if (!pending[key]) throw new Error(`config/feishu.json 缺少 feishu.pending.${key}`);
  }
  if (!Array.isArray(pending.tableFields) || pending.tableFields.length === 0) {
    throw new Error("config/feishu.json 的 feishu.pending.tableFields 必须是非空数组");
  }
  if (!pending.fieldNames.title || !pending.fieldNames.missingRule || !pending.fieldNames.status) {
    throw new Error(
      "config/feishu.json 的 feishu.pending.fieldNames 至少需要 title / missingRule / status",
    );
  }
  feishu.larkCliPath = process.env.LARK_CLI || expandHome(feishu.larkCliPath);
  if (!existsSync(feishu.larkCliPath)) {
    throw new Error(
      `找不到 lark-cli：${feishu.larkCliPath}\n` +
        `请先安装：npm install --prefix ~/.zcode/tools/lark-cli @larksuite/cli`,
    );
  }
  return config;
}

function usage() {
  console.error(`用法：
  node register-walkthrough.mjs --input draft.json [--select 1,3,5|all] [--dry-run] [--yes] [--allow-duplicate]
  node register-walkthrough.mjs --ensure-pending-table [--dry-run] [--yes]
  node register-walkthrough.mjs --update-record <record_id> [--status 待验证] [--assignee ou_xxx] [--fix-note "..."] [--verify 通过] [--note "..."] [--yes]

默认是 dry-run；只有 --yes 才会真正写入飞书。
--select 用编号菜单选择要登记的条目，例如 --select 1,3,5；不传或 all 表示全部。
草稿里的 issues 写入「走查问题登记」表，pending 写入「待确认项」表。
--ensure-pending-table 只查找/创建「待确认项」表，打印 tableId；--yes 时才真正建表。`);
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    yes: false,
    allowDuplicate: false,
    input: null,
    select: null,
    ensurePendingTable: false,
    updateRecord: null,
    status: null,
    assignee: null,
    fixNote: null,
    verify: null,
    note: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--allow-duplicate") args.allowDuplicate = true;
    else if (a === "--select") args.select = argv[++i];
    else if (a === "--ensure-pending-table") args.ensurePendingTable = true;
    else if (a === "--update-record") args.updateRecord = argv[++i];
    else if (a === "--status") args.status = argv[++i];
    else if (a === "--assignee") args.assignee = argv[++i];
    else if (a === "--fix-note") args.fixNote = argv[++i];
    else if (a === "--verify") args.verify = argv[++i];
    else if (a === "--note") args.note = argv[++i];
    else if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${a}`);
    }
  }
  return args;
}

function parseJsonOutput(out) {
  const text = String(out || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error(`无法解析 lark-cli 输出：${text.slice(0, 800)}`);
  }
}

function runLark(cliPath, args) {
  const res = spawnSync(cliPath, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const detail = `${res.stderr || ""}\n${res.stdout || ""}`.trim();
    const hint =
      /auth|token|401|403|unauthorized|login/i.test(detail)
        ? `\n提示：运行 "${cliPath}" auth status 检查登录态；失效时运行 "${cliPath}" auth login 重新扫码。`
        : "";
    throw new Error(`lark-cli 执行失败（exit ${res.status}）：${detail.slice(0, 2000)}${hint}`);
  }
  return parseJsonOutput(res.stdout);
}

function findRecordId(value) {
  if (typeof value === "string" && /^rec[a-zA-Z0-9]+$/.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecordId(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findRecordId(item);
      if (found) return found;
    }
  }
  return null;
}

function findTableId(value) {
  if (typeof value === "string" && /^tbl[a-zA-Z0-9]+$/.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTableId(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findTableId(item);
      if (found) return found;
    }
  }
  return null;
}

function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function normalizeSeverity(value) {
  if (!value) throw new Error("缺少 severity（严重程度）");
  const raw = String(value).trim();
  return SEVERITY_ALIASES[raw] || raw;
}

function normalizeStatus(value) {
  const raw = String(value || "待处理").trim();
  return STATUS_ALIASES[raw] || raw;
}

function normalizeVerify(value) {
  const raw = String(value || "").trim();
  return VERIFY_ALIASES[raw] || raw;
}

function normalizeTypes(value) {
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return ["其他"];
}

function resolveScreenshots(value, cwd) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((p) => {
    const path = isAbsolute(p) ? p : resolve(cwd, p);
    if (!existsSync(path)) throw new Error(`截图文件不存在：${path}`);
    if (!SCREENSHOT_EXTS.has(extname(path).toLowerCase())) {
      throw new Error(`截图格式不支持：${path}`);
    }
    return path;
  });
}

function truncatePoint(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const punctuation = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf("，"),
    slice.lastIndexOf(" "),
  );
  const cut = punctuation > Math.floor(maxChars * 0.5) ? slice.slice(0, punctuation) : slice;
  return `${cut.trim()}…`;
}

function cleanPoint(value) {
  let point = String(value || "")
    .replace(/^\s*(?:[一二三四五六七八九十]+[、.]|\d+[.、)]|[-•*])\s*/u, "")
    .replace(/^\s*(?:现象|期望)\s*[:：]\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (point && !/[。！？!?；;…]$/u.test(point)) point += "。";
  return point;
}

function splitPointLines(text) {
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const points = [];
  for (const line of lines) {
    const numbered = /^\s*(?:\d+[.、)]|[一二三四五六七八九十]+[、.]|[-•*])\s*/u.test(line);
    if (numbered) {
      points.push(line);
      continue;
    }
    const sentences = line
      .split(/(?<=[。；;])/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    points.push(...(sentences.length > 0 ? sentences : [line]));
  }
  return points.map(cleanPoint).filter(Boolean);
}

function extractSections(raw) {
  const phenMatch = /现象\s*[:：]/u.exec(raw);
  const expMatch = /期望\s*[:：]/u.exec(raw);

  if (phenMatch && expMatch && phenMatch.index < expMatch.index) {
    return {
      hasPhen: true,
      hasExp: true,
      phen: splitPointLines(raw.slice(phenMatch.index + phenMatch[0].length, expMatch.index)),
      exp: splitPointLines(raw.slice(expMatch.index + expMatch[0].length)),
    };
  }
  if (expMatch && phenMatch && expMatch.index < phenMatch.index) {
    return {
      hasPhen: true,
      hasExp: true,
      phen: splitPointLines(raw.slice(phenMatch.index + phenMatch[0].length)),
      exp: splitPointLines(raw.slice(expMatch.index + expMatch[0].length, phenMatch.index)),
    };
  }
  if (phenMatch) {
    return {
      hasPhen: true,
      hasExp: false,
      phen: splitPointLines(raw.slice(phenMatch.index + phenMatch[0].length)),
      exp: [],
    };
  }
  if (expMatch) {
    return {
      hasPhen: false,
      hasExp: true,
      phen: [],
      exp: splitPointLines(raw.slice(expMatch.index + expMatch[0].length)),
    };
  }
  return { hasPhen: false, hasExp: false, phen: splitPointLines(raw), exp: [] };
}

function classifyFlatPoints(points) {
  const phen = [];
  const exp = [];
  const expectationRe =
    /^(?:期望|建议|应该|需要|修复|调整|补齐|改为|统一|增加|删除|保持|对齐|还原)/u;
  for (const point of points) {
    if (expectationRe.test(point)) exp.push(point);
    else phen.push(point);
  }
  if (phen.length === 0) {
    throw new Error("问题描述缺少「现象」内容，请补充实际看到的问题");
  }
  if (exp.length === 0) {
    exp.push("与 Figma 设计稿/交互说明保持一致。");
  }
  return { phen, exp };
}

function formatSection(label, points, options) {
  const cleaned = points
    .map(cleanPoint)
    .filter(Boolean)
    .slice(0, options.maxPointsPerSection)
    .map((point) => truncatePoint(point, options.maxCharsPerPoint));
  if (cleaned.length === 0) return null;
  return `${label}：\n${cleaned.map((point, index) => `${index + 1}. ${point}`).join("\n")}`;
}

function formatDescription(value, config) {
  const raw = String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!raw) throw new Error("问题描述不能为空");

  const options = {
    maxPointsPerSection: config?.walkthrough?.description?.maxPointsPerSection ?? 3,
    maxCharsPerPoint: config?.walkthrough?.description?.maxCharsPerPoint ?? 100,
    maxTotalChars: config?.walkthrough?.description?.maxTotalChars ?? 800,
  };

  let sections = extractSections(raw);

  if (!sections.hasPhen && !sections.hasExp) {
    // 完全扁平：按语义分到现象/期望，避免同一条要点重复出现在两段。
    const flat = classifyFlatPoints(sections.phen);
    sections = { ...sections, phen: flat.phen, exp: flat.exp };
  } else if (!sections.hasExp) {
    // 只有「现象：」：把其中的建议类要点分到期望。
    const flat = classifyFlatPoints(sections.phen);
    sections = { ...sections, phen: flat.phen, exp: flat.exp };
  } else if (!sections.hasPhen) {
    // 只有「期望：」：尝试从期望内容里分离出现象；分不出就报错。
    const flat = classifyFlatPoints(sections.exp);
    sections = { ...sections, phen: flat.phen, exp: flat.exp };
  } else {
    if (sections.phen.length === 0) {
      throw new Error("问题描述缺少「现象」内容，请补充实际看到的问题");
    }
    if (sections.exp.length === 0) {
      sections.exp = ["与 Figma 设计稿/交互说明保持一致。"];
    }
  }

  const parts = [
    formatSection("现象", sections.phen, options),
    formatSection("期望", sections.exp, options),
  ].filter(Boolean);

  const formatted = parts.join("\n\n");
  if (!formatted) throw new Error("问题描述格式化后为空");
  return formatted.length <= options.maxTotalChars
    ? formatted
    : `${formatted.slice(0, options.maxTotalChars - 1)}…`;
}

function normalizeIssue(issue, config, cwd) {
  const title = String(issue.title || issue["问题标题"] || "").trim();
  const module = String(issue.module || issue["走查页面/模块"] || "").trim();
  const baselineRef = String(issue.baselineRef || issue["基线依据"] || "").trim();
  const description = formatDescription(issue.description || issue["问题描述"], config);
  if (!title) throw new Error("问题缺少 title（问题标题）");
  if (!module) throw new Error(`问题「${title}」缺少 module（走查页面/模块）`);
  if (!baselineRef) {
    throw new Error(`问题「${title}」缺少 baselineRef（B 编号 + node id），不允许登记`);
  }
  if (!description) throw new Error(`问题「${title}」缺少 description（问题描述）`);
  return {
    title,
    module,
    baselineRef,
    description,
    types: normalizeTypes(issue.types || issue["问题类型"]),
    severity: normalizeSeverity(issue.severity || issue["严重程度"]),
    status: normalizeStatus(issue.status || issue["状态"]),
    version: String(issue.version || issue["版本/批次"] || config.feishu.defaultVersion || ""),
    notes: issue.notes || issue["备注"] || "",
    assigneeOpenId: issue.assigneeOpenId || null,
    screenshots: resolveScreenshots(issue.screenshots, cwd),
  };
}

function fieldNames(config) {
  return config.feishu.fieldNames;
}

function pendingConfig(config) {
  return config.feishu.pending;
}

function pendingFieldNames(config) {
  return pendingConfig(config).fieldNames;
}

function normalizePendingStatus(config, value) {
  const P = pendingConfig(config);
  const raw = String(value || P.statusDefault || "待设计补充").trim();
  const allowed = new Set(
    (P.tableFields.find((field) => field.name === P.fieldNames.status)?.options || []).map(
      (option) => option.name,
    ),
  );
  if (allowed.size > 0 && !allowed.has(raw)) {
    throw new Error(`待确认项状态「${raw}」不可用；可选：${[...allowed].join("、")}`);
  }
  return raw;
}

function normalizePending(item, config, cwd) {
  const P = pendingConfig(config);
  const title = String(item.title || item[P.fieldNames.title] || "").trim();
  const module = String(item.module || item[P.fieldNames.module] || "").trim();
  const missingRule = String(item.missingRule || item[P.fieldNames.missingRule] || "").trim();
  if (!title) throw new Error("待确认项缺少 title（待确认项标题）");
  if (!module) throw new Error(`待确认项「${title}」缺少 module（走查页面/模块）`);
  if (!missingRule) throw new Error(`待确认项「${title}」缺少 missingRule（缺失的规则）`);
  return {
    title,
    module,
    missingRule,
    impact: String(item.impact || item[P.fieldNames.impact] || "").trim(),
    baselineRef: String(item.baselineRef || item[P.fieldNames.baselineRef] || "").trim(),
    notes: String(item.notes || item[P.fieldNames.notes] || "").trim(),
    version: String(item.version || item[P.fieldNames.version] || config.feishu.defaultVersion || ""),
    status: normalizePendingStatus(config, item.status || item[P.fieldNames.status]),
    screenshots: resolveScreenshots(item.screenshots, cwd),
  };
}

function listTables(config) {
  const res = runLark(config.feishu.larkCliPath, [
    "base",
    "+table-list",
    "--base-token",
    config.feishu.baseToken,
    "--format",
    "json",
  ]);
  if (!res.ok) throw new Error(`读取飞书数据表失败：${JSON.stringify(res).slice(0, 1000)}`);
  return res?.data?.tables || [];
}

/**
 * 找到「待确认项」表；配置了 tableId 就直接用，否则按表名查找，找不到时在 create 模式下建表。
 * 表结构来自 config.feishu.pending.tableFields，不依赖任何外部记录。
 */
function resolvePendingTable(config, { create }) {
  const P = pendingConfig(config);
  if (P.tableId) {
    return { tableId: P.tableId, tableName: P.tableName, source: "config", created: false };
  }

  const existing = listTables(config).find((table) => table.name === P.tableName);
  if (existing) {
    return { tableId: existing.id, tableName: P.tableName, source: "existing", created: false };
  }

  if (!create) {
    return {
      tableId: null,
      tableName: P.tableName,
      source: "missing",
      created: false,
      willCreate: true,
      tableFields: P.tableFields,
    };
  }

  const res = runLark(config.feishu.larkCliPath, [
    "base",
    "+table-create",
    "--base-token",
    config.feishu.baseToken,
    "--name",
    P.tableName,
    "--fields",
    JSON.stringify(P.tableFields),
    "--format",
    "json",
  ]);
  if (!res.ok) throw new Error(`创建「${P.tableName}」表失败：${JSON.stringify(res).slice(0, 1200)}`);
  const tableId = findTableId(res);
  if (!tableId) {
    throw new Error(`建表成功但未找到 table_id：${JSON.stringify(res).slice(0, 1200)}`);
  }
  return { tableId, tableName: P.tableName, source: "created", created: true };
}

function buildPendingPayload(item, config, fieldsByName) {
  const F = pendingFieldNames(config);
  for (const key of ["title", "module", "missingRule", "status", "version", "reportDate"]) {
    if (!F[key]) throw new Error(`config/feishu.json 缺少 feishu.pending.fieldNames.${key}`);
    assertField(fieldsByName, F[key]);
  }
  assertSelect(fieldsByName, F.status, [item.status]);

  const payload = {
    [F.title]: item.title,
    [F.module]: item.module,
    [F.missingRule]: item.missingRule,
    [F.status]: [item.status],
    [F.version]: item.version,
    [F.reportDate]: today(),
  };
  if (item.impact) payload[F.impact] = item.impact;
  if (item.baselineRef) payload[F.baselineRef] = item.baselineRef;
  if (item.notes) payload[F.notes] = item.notes;
  return payload;
}

function searchDuplicatePendings(config, tableId, item) {
  const F = pendingFieldNames(config);
  try {
    const res = runLark(config.feishu.larkCliPath, [
      "base",
      "+record-search",
      "--base-token",
      config.feishu.baseToken,
      "--table-id",
      tableId,
      "--keyword",
      item.title.slice(0, 20),
      "--search-field",
      F.title,
      "--search-field",
      F.missingRule,
      "--limit",
      "20",
      "--format",
      "json",
    ]);
    const d = res?.data;
    if (!d || !Array.isArray(d.data) || !Array.isArray(d.fields)) return [];
    const idx = d.fields.indexOf(F.title);
    if (idx < 0) return [];
    const normalized = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
    return d.data
      .map((row) => String(row[idx] ?? ""))
      .filter((title) => title && normalized(title) === normalized(item.title));
  } catch (error) {
    throw new Error(`待确认项查重失败：${error.message}`);
  }
}



function loadFields(config, tableId = config.feishu.tableId) {
  const res = runLark(config.feishu.larkCliPath, [
    "base",
    "+field-list",
    "--base-token",
    config.feishu.baseToken,
    "--table-id",
    tableId,
    "--format",
    "json",
  ]);
  if (!res.ok || !res.data || !Array.isArray(res.data.fields)) {
    throw new Error(`读取飞书字段失败：${JSON.stringify(res).slice(0, 1000)}`);
  }
  return res.data.fields;
}

function getReporterOpenId(config) {
  if (config.feishu.reporterOpenId) return config.feishu.reporterOpenId;
  try {
    const res = runLark(config.feishu.larkCliPath, ["auth", "status"]);
    return res?.identities?.user?.openId || null;
  } catch {
    return null;
  }
}

function optionNames(field) {
  return Array.isArray(field.options) ? field.options.map((o) => o.name) : [];
}

function assertField(fieldsByName, name) {
  const field = fieldsByName.get(name);
  if (!field) {
    throw new Error(
      `飞书表缺少字段「${name}」。现有字段：${[...fieldsByName.keys()].join("、")}`,
    );
  }
  return field;
}

function assertSelect(fieldsByName, name, values) {
  const field = assertField(fieldsByName, name);
  if (field.type !== "select") throw new Error(`字段「${name}」不是单选/多选`);
  const allowed = optionNames(field);
  const invalid = values.filter((v) => !allowed.includes(v));
  if (invalid.length) {
    throw new Error(`字段「${name}」不接受值：${invalid.join("、")}；可选：${allowed.join("、")}`);
  }
}

function buildPayload(issue, config, fieldsByName, reporterOpenId) {
  const F = fieldNames(config);
  assertField(fieldsByName, F.title);
  assertField(fieldsByName, F.module);
  assertField(fieldsByName, F.types);
  assertField(fieldsByName, F.severity);
  assertField(fieldsByName, F.description);
  assertField(fieldsByName, F.version);
  assertField(fieldsByName, F.reportDate);
  assertField(fieldsByName, F.status);
  assertField(fieldsByName, F.notes);

  assertSelect(fieldsByName, F.types, issue.types);
  assertSelect(fieldsByName, F.severity, [issue.severity]);
  assertSelect(fieldsByName, F.status, [issue.status]);

  const payload = {
    [F.title]: issue.title,
    [F.module]: issue.module,
    [F.types]: issue.types,
    [F.severity]: [issue.severity],
    [F.description]: issue.description,
    [F.version]: issue.version,
    [F.reportDate]: today(),
    [F.status]: [issue.status],
  };
  if (issue.notes) payload[F.notes] = issue.notes;
  const baselineNote = `基线：${issue.baselineRef}`;
  if (!String(payload[F.notes] || "").includes(issue.baselineRef)) {
    payload[F.notes] = payload[F.notes]
      ? `${payload[F.notes]}；${baselineNote}`
      : baselineNote;
  }
  if (reporterOpenId) payload[F.reporter] = [{ id: reporterOpenId }];
  if (issue.assigneeOpenId) payload[F.assignee] = [{ id: issue.assigneeOpenId }];
  return payload;
}

function buildUpdatePayload(args, config, fieldsByName) {
  const F = fieldNames(config);
  const payload = {};
  if (args.status) {
    const status = normalizeStatus(args.status);
    assertSelect(fieldsByName, F.status, [status]);
    payload[F.status] = [status];
  }
  if (args.assignee) {
    assertField(fieldsByName, F.assignee);
    payload[F.assignee] = [{ id: args.assignee }];
  }
  if (args.fixNote) {
    assertField(fieldsByName, F.fixNote);
    payload[F.fixNote] = args.fixNote;
  }
  if (args.verify) {
    const verify = normalizeVerify(args.verify);
    assertSelect(fieldsByName, F.verify, [verify]);
    payload[F.verify] = [verify];
  }
  if (args.note) {
    assertField(fieldsByName, F.notes);
    payload[F.notes] = args.note;
  }
  if (Object.keys(payload).length === 0) {
    throw new Error("--update-record 至少需要 --status / --assignee / --fix-note / --verify / --note 之一");
  }
  return payload;
}

function searchDuplicates(config, issue) {
  const F = fieldNames(config);
  const keyword = issue.title.slice(0, 20);
  try {
    const res = runLark(config.feishu.larkCliPath, [
      "base",
      "+record-search",
      "--base-token",
      config.feishu.baseToken,
      "--table-id",
      config.feishu.tableId,
      "--keyword",
      keyword,
      "--search-field",
      F.title,
      "--search-field",
      F.description,
      "--limit",
      "20",
      "--format",
      "json",
    ]);
    const d = res?.data;
    if (!d || !Array.isArray(d.data) || !Array.isArray(d.fields)) return [];
    const idx = d.fields.indexOf(F.title);
    if (idx < 0) return [];
    const normalized = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
    return d.data
      .map((row) => String(row[idx] ?? ""))
      .filter((title) => title && normalized(title) === normalized(issue.title));
  } catch (error) {
    throw new Error(`查重失败：${error.message}`);
  }
}

function createRecord(config, payload, tableId = config.feishu.tableId) {
  const res = runLark(config.feishu.larkCliPath, [
    "base",
    "+record-upsert",
    "--base-token",
    config.feishu.baseToken,
    "--table-id",
    tableId,
    "--format",
    "json",
    "--json",
    JSON.stringify(payload),
  ]);
  if (!res.ok) throw new Error(`创建记录失败：${JSON.stringify(res).slice(0, 1200)}`);
  const recordId = findRecordId(res);
  if (!recordId) throw new Error(`创建记录成功但未找到 record_id：${JSON.stringify(res).slice(0, 1200)}`);
  return recordId;
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function uploadScreenshots(config, recordId, files, tableId = config.feishu.tableId) {
  if (!files.length) return { ok: true, files: [] };
  const F = tableId === config.feishu.tableId ? fieldNames(config) : pendingFieldNames(config);
  const args = [
    "base",
    "+record-upload-attachment",
    "--base-token",
    config.feishu.baseToken,
    "--table-id",
    tableId,
    "--record-id",
    recordId,
    "--field-id",
    F.screenshot,
    "--format",
    "json",
  ];
  for (const file of files) args.push("--file", file);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = runLark(config.feishu.larkCliPath, args);
      if (res.ok) return { ok: true, files };
      lastError = new Error(JSON.stringify(res).slice(0, 1200));
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await sleep(1000);
  }
  throw lastError;
}

function recordUrl(config, recordId, tableId = config.feishu.tableId) {
  const base = config.feishu.baseUrl || "";
  if (!base) return null;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}table=${tableId}&record=${recordId}`;
}

function print(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const mode = args.yes ? "write" : "dry-run";

  if (args.ensurePendingTable) {
    const info = resolvePendingTable(config, { create: mode === "write" });
    if (info.tableId && mode === "write") {
      const expected = pendingConfig(config).tableFields.map((field) => field.name);
      const actual = new Set(
        info.created
          ? expected
          : loadFields(config, info.tableId).map((field) => field.name),
      );
      const missingFields = expected.filter((name) => !actual.has(name));
      print({
        ok: missingFields.length === 0,
        mode,
        action: "ensure-pending-table",
        ...info,
        missingFields,
      });
      if (missingFields.length > 0) process.exitCode = 3;
      return;
    }
    print({ ok: true, mode, action: "ensure-pending-table", ...info });
    return;
  }

  const fields = loadFields(config);
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  const reporterOpenId = getReporterOpenId(config);

  if (args.updateRecord) {
    const payload = buildUpdatePayload(args, config, fieldsByName);
    if (!args.yes) {
      print({ ok: true, mode, action: "update", recordId: args.updateRecord, payload });
      return;
    }
    const res = runLark(config.feishu.larkCliPath, [
      "base",
      "+record-upsert",
      "--base-token",
      config.feishu.baseToken,
      "--table-id",
      config.feishu.tableId,
      "--record-id",
      args.updateRecord,
      "--format",
      "json",
      "--json",
      JSON.stringify(payload),
    ]);
    print({ ok: Boolean(res.ok), mode, action: "update", recordId: args.updateRecord, response: res });
    return;
  }

  if (!args.input) {
    usage();
    process.exit(1);
  }

  const draft = JSON.parse(readFileSync(resolve(args.input), "utf8"));
  const hasArrays = Array.isArray(draft.issues) || Array.isArray(draft.pending);
  const rawIssues = Array.isArray(draft.issues) ? draft.issues : hasArrays ? [] : [draft];
  const rawPending = Array.isArray(draft.pending) ? draft.pending : [];
  if (rawIssues.length === 0 && rawPending.length === 0) {
    throw new Error("草稿里没有 issues 或 pending 条目");
  }

  const issues = rawIssues.map((issue) => normalizeIssue(issue, config, process.cwd()));
  const pendings = rawPending.map((item) => normalizePending(item, config, process.cwd()));
  const issueResults = [];
  const pendingResults = [];

  for (const issue of issues) {
    const duplicates = searchDuplicates(config, issue);
    if (duplicates.length > 0 && !args.allowDuplicate) {
      issueResults.push({
        title: issue.title,
        mode,
        duplicate: true,
        duplicates,
        note: "已存在同名问题；如确认要重复登记，加 --allow-duplicate",
      });
      continue;
    }

    const payload = buildPayload(issue, config, fieldsByName, reporterOpenId);
    if (mode === "dry-run") {
      issueResults.push({
        title: issue.title,
        mode,
        duplicate: duplicates.length > 0,
        payload,
        screenshots: issue.screenshots,
      });
      continue;
    }

    const recordId = createRecord(config, payload);
    let upload = null;
    let uploadError = null;
    try {
      upload = await uploadScreenshots(config, recordId, issue.screenshots);
    } catch (error) {
      uploadError = error.message;
    }
    issueResults.push({
      title: issue.title,
      mode,
      duplicate: duplicates.length > 0,
      recordId,
      recordUrl: recordUrl(config, recordId),
      screenshots: issue.screenshots,
      upload,
      uploadError,
    });
  }

  let pendingTable = null;
  if (pendings.length > 0) {
    // 配置了 tableId 就直接用；否则按表名查找；--yes 时找不到才按 config 里的 schema 建表。
    pendingTable = resolvePendingTable(config, { create: mode === "write" });

    if (!pendingTable.tableId) {
      for (const item of pendings) {
        pendingResults.push({
          title: item.title,
          mode,
          willCreateTable: true,
          tableName: pendingTable.tableName,
          tableFields: pendingTable.tableFields,
          screenshots: item.screenshots,
          note: "本次为 dry-run；--yes 时才会创建该表并写入",
        });
      }
    } else {
      // 刚建表时直接使用配置里的 schema，避免建表后立即读取字段遇到异步延迟。
      const pendingFields = pendingTable.created
        ? pendingConfig(config).tableFields.map((field) => ({
            name: field.name,
            type: field.type,
            options: field.options || [],
          }))
        : loadFields(config, pendingTable.tableId);
      const pendingFieldsByName = new Map(pendingFields.map((field) => [field.name, field]));

      for (const item of pendings) {
        // 刚建的表不可能有重复记录，跳过检索，避免建表后索引未就绪。
        const duplicates = pendingTable.created
          ? []
          : searchDuplicatePendings(config, pendingTable.tableId, item);
        if (duplicates.length > 0 && !args.allowDuplicate) {
          pendingResults.push({
            title: item.title,
            mode,
            duplicate: true,
            duplicates,
            note: "待确认项已存在同名条目；如确认要重复登记，加 --allow-duplicate",
          });
          continue;
        }

        const payload = buildPendingPayload(item, config, pendingFieldsByName);
        if (mode === "dry-run") {
          pendingResults.push({
            title: item.title,
            mode,
            duplicate: duplicates.length > 0,
            payload,
            screenshots: item.screenshots,
            tableId: pendingTable.tableId,
          });
          continue;
        }

        const recordId = createRecord(config, payload, pendingTable.tableId);
        let upload = null;
        let uploadError = null;
        try {
          upload = await uploadScreenshots(config, recordId, item.screenshots, pendingTable.tableId);
        } catch (error) {
          uploadError = error.message;
        }
        pendingResults.push({
          title: item.title,
          mode,
          duplicate: duplicates.length > 0,
          recordId,
          recordUrl: recordUrl(config, recordId, pendingTable.tableId),
          screenshots: item.screenshots,
          upload,
          uploadError,
        });
      }
    }
  }

  const failed = [...issueResults, ...pendingResults].some((result) => result.uploadError);
  print({
    ok: !failed,
    mode,
    count: issueResults.length + pendingResults.length,
    pendingTable,
    results: { issues: issueResults, pending: pendingResults },
  });
  if (failed) process.exitCode = 2;
}

main().catch((error) => {
  print({ ok: false, error: error.message });
  process.exitCode = 1;
});
