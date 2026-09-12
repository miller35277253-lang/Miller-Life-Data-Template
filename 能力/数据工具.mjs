#!/usr/bin/env node
/**
 * 个人数据系统查询/校验工具
 * 用法:
 *   node 能力/数据工具.mjs list [type] [--limit N]
 *   node 能力/数据工具.mjs stats <type> [field]
 *   node 能力/数据工具.mjs validate   # 仅结构校验
 *   node 能力/数据工具.mjs check      # 综合检查（结构+关联，提交前用）
 *   node 能力/数据工具.mjs check <type>  # 单类型快查
 *   node 能力/数据工具.mjs due <YYYY-MM-DD>  # 到期清单（唯一权威，禁止自行推算）
 *   node 能力/数据工具.mjs types
 *   node 能力/数据工具.mjs nextid <类型key> [YYYY-MM-DD]  # 生成新记录唯一ID（禁止凭想象分配）
 *   node 能力/数据工具.mjs query <类型key> --from <YYYY-MM-DD> [--to <YYYY-MM-DD>]  # 按时间范围查询记录（全量召回，查询类问题必须用这个）
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { runRelationChecks } from "./数据检查/关联检查.mjs";
import { dueTasks, dueLabel, uncomputableTasks } from "./调度.mjs";
import { nowDate } from "./时区.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "数据");
const RECORDS = DATA; // 所有JSONL类型直接平铺在 数据/ 下

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function loadTypes() {
  // 扫描 数据/ 和根目录下的所有文件夹，找 "*：类型配置.json" 文件
  const types = {};
  const scanDirs = [DATA, ROOT]; // 数据/ 和根目录（收藏资料在根目录）
  for (const baseDir of scanDirs) {
    if (!existsSync(baseDir)) continue;
    for (const dirName of readdirSync(baseDir)) {
      const dirPath = join(baseDir, dirName);
      if (!statSync(dirPath).isDirectory()) continue;
      // 找必读文件
      const files = readdirSync(dirPath).filter(f => f.endsWith("：类型配置.json"));
      for (const f of files) {
        const typedef = readJson(join(dirPath, f));
        if (typedef && typedef.key) {
          types[typedef.key] = typedef;
        }
      }
    }
  }
  return types;
}

// 根据类型key获取实际存储路径
function getTypeStorage(typeKey) {
  const types = loadTypes();
  if (types[typeKey] && types[typeKey].storage) {
    return types[typeKey].storage;
  }
  return null;
}

function getTypeDir(typeKey) {
  const storage = getTypeStorage(typeKey);
  if (!storage) return join(RECORDS, typeKey);
  // storage可能是文件路径（数据/xxx/yyy.jsonl）或目录路径（数据/xxx/）
  if (storage.endsWith(".jsonl")) {
    return join(ROOT, dirname(storage));
  }
  return join(ROOT, storage);
}

// 生成下一个ID：<type>-<YYYYMMDD>-<5位序号>
// 从实际存储路径读取已有记录，避免重复ID
function nextId(typeKey, dateStr) {
  const storage = getTypeStorage(typeKey);
  if (!storage) {
    return null; // 类型未注册，需要先创建类型配置
  }
  // 确定jsonl文件路径
  let filepath;
  if (storage.endsWith(".jsonl")) {
    filepath = join(ROOT, storage);
  } else {
    // 目录路径，找目录下的jsonl文件
    const dir = join(ROOT, storage);
    if (!existsSync(dir)) return `${typeKey}-${dateStr.replace(/-/g, "")}-00001`;
    const jsonlFiles = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    if (!jsonlFiles.length) return `${typeKey}-${dateStr.replace(/-/g, "")}-00001`;
    filepath = join(dir, jsonlFiles[0]);
  }
  if (!existsSync(filepath)) {
    return `${typeKey}-${dateStr.replace(/-/g, "")}-00001`;
  }
  const lines = readFileSync(filepath, "utf8").split("\n").filter(l => l.trim());
  const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const prefix = `${typeKey}-${dateStr.replace(/-/g, "")}-`;
  const nums = records
    .filter(r => r.id && r.id.startsWith(prefix))
    .map(r => parseInt(r.id.slice(prefix.length), 10))
    .filter(n => !Number.isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}${String(next).padStart(5, "0")}`;
}

function loadRecords(type, errs) {
  const dir = getTypeDir(type);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n");
    lines.forEach((l, i) => {
      if (!l.trim()) return;
      try {
        const r = JSON.parse(l);
        out.push({ id: r.id, ...r.meta, type: r.type, data: r.data });
      } catch (e) {
        const msg = `✗ ${type}/${f}:${i + 1}: JSON 解析失败（已跳过坏行）`;
        if (errs) errs.push(msg); else console.error(msg);
      }
    });
  }
  return out.sort((a, b) => {
    const ta = (a.data && (a.data.startTime || a.data.time)) || "";
    const tb = (b.data && (b.data.startTime || b.data.time)) || "";
    return String(ta).localeCompare(String(tb));
  });
}

function loadTasks() {
  const dir = getTypeDir("task");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith("：类型配置.json"))
    .map((f) => {
      const raw = readJson(join(dir, f));
      // 支持两种格式：嵌套格式{id,type,data,meta}和扁平格式{id,type,title,...}
      if (raw.data) {
        // 嵌套格式：展开data，type默认设为reminder（schedule.mjs期望的子类型）
        return { id: raw.id, type: "reminder", ...raw.data, ...raw.meta };
      }
      return raw;
    });
}

export function runValidate() {
      const types = loadTypes();
// 校验：JSONL 可解析、type 已注册、projectId 存在、任务字段可计算、ID格式与唯一性
      console.log("校验类型定义 + 记录 + 任务 ...");
      let err = 0;
      const errs = [];
      const allIds = new Set(); // 用于ID唯一性校验
      // ID格式正则：类型前缀-8位日期-5位数字（project用标准ID格式）
      const idFormatRegex = /^[a-z_]+-\d{8}-\d{5}$/;
      // 加载所有主题 ID（用于 projectId 校验）
      const projectsDir = getTypeDir("project");
      const projectIds = existsSync(projectsDir)
        ? readdirSync(projectsDir).filter((f) => f.endsWith(".json") && !f.endsWith("：类型配置.json")).map((f) => readJson(join(projectsDir, f)).id)
        : [];
      // 加载所有人物 ID（用于 peopleIds 校验），同时校验人物ID格式
      const peopleDir = getTypeDir("person");
      const peopleIds = existsSync(peopleDir)
        ? readdirSync(peopleDir).filter((f) => f.endsWith(".json") && !f.endsWith("：类型配置.json")).map((f) => {
            const pid = readJson(join(peopleDir, f)).id;
            if (!idFormatRegex.test(pid)) {
              errs.push(`✗ people/${f}: 人物ID "${pid}" 格式不合法（应为 person-YYYYMMDD-00001）`);
            }
            if (allIds.has(pid)) {
              errs.push(`✗ people/${f}: 人物ID "${pid}" 重复`);
            }
            allIds.add(pid);
            return pid;
          })
        : [];
      // 遍历所有已加载的类型key
      for (const typeKey of Object.keys(types)) {
        if (typeKey === "command") continue; // 用户指令追溯文件，不参与业务数据校验
        const dir = getTypeDir(typeKey);
        if (!existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith(".jsonl"))) continue;
        loadRecords(typeKey, errs).forEach((r) => {
          if (!types[r.type]) { errs.push(`✗ ${typeKey}: 未注册类型 ${r.type}`); }
          // ID格式校验
          const rid = r.id;
          if (!idFormatRegex.test(rid)) {
            errs.push(`✗ ${typeKey}: 记录ID "${rid}" 格式不合法（应为 <类型>-YYYYMMDD-00001）`);
          }
          // ID唯一性校验
          if (allIds.has(rid)) {
            errs.push(`✗ ${typeKey}: 记录ID "${rid}" 重复`);
          }
          allIds.add(rid);
          const tid = r.data && r.data.projectId;
          if (tid && !projectIds.includes(tid)) {
            errs.push(`✗ ${dir}: projectId "${tid}" 不存在于项目目录`);
          }
          const pids = r.data && r.data.peopleIds;
          if (pids) {
            pids.split(",").map((s) => s.trim()).filter(Boolean).forEach((pid) => {
              if (!peopleIds.includes(pid)) {
                errs.push(`✗ ${dir}: peopleId "${pid}" 不存在于人物目录`);
              }
            });
          }
          // 校验 timeGranularity 合法值（仅 activity 类型）
          const tg = r.data && r.data.timeGranularity;
          if (tg && !["year", "month", "day", "hour", "minute"].includes(tg)) {
            errs.push(`✗ ${dir}: timeGranularity "${tg}" 不合法（应为 year/month/day/hour/minute）`);
          }
          // 校验：标注"进行中"的 activity 不能有 endTime
          const note = (r.data && r.data.note) || "";
          const hasEndTime = r.data && r.data.endTime;
          if (note.includes("进行中") && hasEndTime) {
            errs.push(`✗ ${dir}/${r.id}: 标注"进行中"但有 endTime="${hasEndTime}"，进行中的事件不应设结束时间`);
          }
        });
      }
      // 校验任务的 projectId 和 peopleIds
      for (const task of loadTasks()) {
        const tid = task.projectId;
        if (tid && !projectIds.includes(tid)) {
          errs.push(`✗ tasks/${task.id || "(无id)"}.json: projectId "${tid}" 不存在于项目目录`);
        }
        const pids = task.peopleIds;
        if (pids) {
          pids.split(",").map((s) => s.trim()).filter(Boolean).forEach((pid) => {
            if (!peopleIds.includes(pid)) {
              errs.push(`✗ tasks/${task.id || "(无id)"}.json: peopleId "${pid}" 不存在于人物目录`);
            }
          });
        }
      }
      for (const { task, issues } of uncomputableTasks(loadTasks())) {
        errs.push(`✗ tasks/${task.id || "(无id)"}.json: ${issues.join("；")}`);
      }
      errs.forEach((m) => console.error(m));
      // 双向关联一致性检查
      try {
        execSync(`node "${join(ROOT, "能力/数据检查/关联检查.mjs")}"`, { stdio: "pipe" });
      } catch (e) {
        const output = e.stdout ? e.stdout.toString() : "";
        const errors = output.split("\n").filter((l) => l.trim().startsWith("✗"));
        errors.forEach((m) => console.error(m));
        errs.push(...errors);
      }
      err = errs.length;
      console.log(err ? `✗ 发现 ${err} 个问题` : "✓ 结构正常");
      console.log("\n⚠️ 提交铁律：所有 git 提交必须通过 `node 能力/提交并确认.mjs \"提交信息\"` 执行，禁止直接 git add/commit/push。工具返回的确认信息必须原样返回给用户。");
      return err;
}

function cmd() {
  const [,, cmd, ...args] = process.argv;
  const types = loadTypes();

  switch (cmd) {
    case "types": {
      console.log("已注册数据类型:");
      for (const t of Object.values(types)) {
        const constraints = (t.核心约束 || []).join("; ");
        console.log(`  ${t.name} (${t.key}) ${t.unit ? "[" + t.unit + "]" : ""} 核心约束: ${constraints}`);
      }
      return;
    }
    case "due": {
      const dateStr = args[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) {
        console.error("用法: node 能力/数据工具.mjs due <YYYY-MM-DD>");
        process.exit(1);
      }
      const tasks = loadTasks();
      const bad = uncomputableTasks(tasks);
      if (bad.length) {
        console.warn(`⚠ ${bad.length} 个任务字段不完整，无法可靠计算到期：`);
        for (const { task, issues } of bad) {
          console.warn(`  - ${task.id || "(无id)"}: ${issues.join("；")}`);
        }
      }
      const due = dueTasks(tasks, dateStr);
      if (!due.length) {
        console.log(`${dateStr}: 无到期任务`);
        return;
      }
      console.log(`${dateStr} 到期清单:`);
      for (const t of due) {
        console.log(`  - [${t.type}] ${t.title}  (${dueLabel(t, dateStr)})`);
      }
      return;
    }
    case "check": {
      const type = args[0];
      if (!type) {
        // 无参数 = 综合检查（结构校验 + 关联检查，单次进程）
        console.log("=== 综合检查：结构 + 关联 ===");
        console.log("\n--- 结构校验 ---");
        const structErr = runValidate();
        console.log("\n--- 关联检查 ---");
        const relResult = runRelationChecks();
        const total = structErr + relResult.errors.length;
        console.log("\n=== 综合检查汇总 ===");
        console.log(total ? `✗ 共发现 ${total} 个问题` : "✅ 所有检查通过！");
        process.exit(total ? 1 : 0);
        return;
      }
      const errs = [];
      const records = loadRecords(type, errs);
      records.forEach((r) => {
        if (!types[r.type]) errs.push(`✗ ${type}: 未注册类型 ${r.type}`);
      });
      errs.forEach((m) => console.error(m));
      console.log(errs.length ? `✗ ${type} 发现 ${errs.length} 个问题` : `✓ ${type} 结构正常（${records.length} 条）`);
      process.exit(errs.length ? 1 : 0);
      return;
    }
    case "list": {
      const type = args[0];
      const limitIdx = args.indexOf("--limit");
      const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
      if (!type) { console.error("需要指定类型，如: node 能力/数据工具.mjs list weight"); process.exit(1); }
      const recs = loadRecords(type).slice(0, limit);
      console.log(`${type} 共 ${recs.length} 条:`);
      for (const r of recs) {
        console.log(`  ${r.data.startTime || r.data.time}  ${JSON.stringify(r.data)} [${r.source}]`);
      }
      return;
    }
    case "stats": {
      const [type, field = "value"] = args;
      if (!type) { console.error("需要指定类型"); process.exit(1); }
      const recs = loadRecords(type).filter((r) => r.data[field] !== undefined);
      const nums = recs.map((r) => Number(r.data[field])).filter((n) => !Number.isNaN(n));
      if (!nums.length) { console.log("无数值可统计"); return; }
      const sum = nums.reduce((a, b) => a + b, 0);
      console.log(`${type}.${field}  (${nums.length} 条)`);
      console.log(`  平均: ${(sum / nums.length).toFixed(2)}  最小: ${Math.min(...nums)}  最大: ${Math.max(...nums)}  合计: ${sum.toFixed(2)}`);
      return;
    }
    case "validate": {
      const err = runValidate();
      process.exit(err ? 1 : 0);
      return;
    }
    case "nextid": {
      const typeKey = args[0];
      const dateStr = args[1] || nowDate();
      if (!typeKey) {
        console.error("用法: node 能力/数据工具.mjs nextid <类型key> [YYYY-MM-DD]");
        console.error("示例: node 能力/数据工具.mjs nextid intake");
        process.exit(1);
      }
      const id = nextId(typeKey, dateStr);
      if (!id) {
        console.error(`✗ 类型 "${typeKey}" 未注册，请先创建类型配置文件（*：类型配置.json）`);
        process.exit(1);
      }
      console.log(id);
      return;
    }
    case "query": {
      const typeKey = args[0];
      if (!typeKey) {
        console.error("用法: node 能力/数据工具.mjs query <类型key> --from <YYYY-MM-DD> [--to <YYYY-MM-DD>]");
        console.error("示例: node 能力/数据工具.mjs query activity --from 2026-09-07");
        console.error("示例: node 能力/数据工具.mjs query expense --from 2026-09-01 --to 2026-09-07");
        process.exit(1);
      }

      const fromIdx = args.indexOf("--from");
      const toIdx = args.indexOf("--to");
      const fromStr = fromIdx >= 0 ? args[fromIdx + 1] : null;
      const toStr = toIdx >= 0 ? args[toIdx + 1] : fromStr;

      if (!fromStr || !/^\d{4}-\d{2}-\d{2}$/.test(fromStr)) {
        console.error("需要指定 --from <YYYY-MM-DD>");
        process.exit(1);
      }

      const storage = getTypeStorage(typeKey);
      if (!storage) {
        console.error(`✗ 类型 "${typeKey}" 未注册，可用类型: ${Object.keys(types).join(", ")}`);
        process.exit(1);
      }

      // 从类型配置读取日期字段名（配置驱动，不硬编码）
      const typeConfig = types[typeKey] || {};
      const dateField = typeConfig.dateField || "time"; // 缺省回退到time

      // 确定 jsonl 文件路径
      let filepath;
      if (storage.endsWith(".jsonl")) {
        filepath = join(ROOT, storage);
      } else {
        const dir = join(ROOT, storage);
        if (!existsSync(dir)) { console.log("（无数据文件）"); return; }
        const jsonlFiles = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
        if (!jsonlFiles.length) { console.log("（无数据文件）"); return; }
        filepath = join(dir, jsonlFiles[0]);
      }

      if (!existsSync(filepath)) { console.log("（无数据文件）"); return; }

      const fromMs = new Date(fromStr + "T00:00:00+08:00").getTime();
      const toMs = new Date(toStr + "T23:59:59+08:00").getTime();

      const lines = readFileSync(filepath, "utf8").split("\n").filter(l => l.trim());
      const matched = [];

      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          const c = rec.data || rec;

          // 从类型配置的 dateField 提取日期（配置驱动，不硬编码字段名）
          const startTime = c[dateField];
          if (!startTime) continue;

          const startMs = new Date(startTime).getTime();
          if (Number.isNaN(startMs)) continue;

          const endTime = c.endTime;
          const endMs = endTime ? new Date(endTime).getTime() : null;

          // 筛选逻辑：
          // - 有 endTime：startTime <= to 且 endTime >= from（跨天活动也包含）
          // - 无 endTime（进行中或瞬时）：startTime 在 [from, to] 范围内
          let inRange;
          if (endMs && !Number.isNaN(endMs)) {
            inRange = startMs <= toMs && endMs >= fromMs;
          } else {
            inRange = startMs >= fromMs && startMs <= toMs;
          }

          if (inRange) matched.push(rec);
        } catch (e) { /* 跳过坏行 */ }
      }

      // 按日期字段升序排列
      matched.sort((a, b) => {
        const ta = ((a.data || a)[dateField] || "");
        const tb = ((b.data || b)[dateField] || "");
        return String(ta).localeCompare(String(tb));
      });

      const typeName = types[typeKey]?.name || typeKey;
      const rangeStr = fromStr === toStr ? fromStr : `${fromStr} ~ ${toStr}`;
      console.log(`=== ${rangeStr} ${typeName}记录（共${matched.length}条）===`);

      if (matched.length === 0) {
        console.log("（无记录）");
        return;
      }

      matched.forEach((rec, i) => {
        const c = rec.data || rec;
        const start = c.startTime || c.time || c.dueDate || c.remindTime || "";
        const end = c.endTime ? `~${c.endTime.slice(11, 16)}` : "";
        const timeStr = start ? `${start.slice(5, 10)} ${start.slice(11, 16)}${end}` : "(无时间)";
        const title = c.activity || c.item || c.title || c.name || c.content || "(无标题)";
        const cat = c.category || c.categoryL1 || "";
        const status = c.status || "";

        // 关键数值信息
        let extra = "";
        if (c.amount !== undefined) {
          extra += ` ${c.amount}${c.unit || ""}`;
          if (c.currency) extra += c.currency === "CNY" ? "元" : c.currency;
        }
        if (c.calories !== undefined) extra += ` ${c.calories}kcal`;

        const parts = [timeStr, title];
        if (cat) parts.push(cat);
        if (status) parts.push(status);
        if (extra.trim()) parts.push(extra.trim());

        console.log(`${String(i + 1).padStart(2)}. ${rec.id} | ${parts.join(" | ")}`);
      });
      return;
    }
    default: {
      console.log("用法:\n  list <type> [--limit N]\n  stats <type> [field]\n  validate\n  check\n  nextid <类型key> [日期]\n  types\n  query <类型key> --from <YYYY-MM-DD> [--to <YYYY-MM-DD>]");
    }
  }
}

cmd();
