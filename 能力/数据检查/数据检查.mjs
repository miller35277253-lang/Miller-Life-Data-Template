#!/usr/bin/env node
/**
 * 数据检查工具（系统级检查）
 * 只做确定性的、不需要语义判断的检查。
 * 用户级检查（字段规范、未知字段、data包装等）由AI根据 数据检查规范.md + 类型定义 执行。
 *
 * 用法：
 *   node 能力/数据检查/数据检查.mjs              # 只检查，不修复
 *   node 能力/数据检查/数据检查.mjs --fix        # 检查并自动修复可修复的问题
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA = join(ROOT, "数据");
// 类型定义自动扫描：各数据文件夹内的「*：类型配置.json」

const args = process.argv.slice(2);
const FIX = args.includes("--fix");

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { return null; }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
    .filter(r => r !== null);
}

function writeJsonl(path, records) {
  writeFileSync(path, records.map(r => JSON.stringify(r, null, 0)).join("\n") + "\n", "utf8");
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => 
    (f.endsWith(".json") || f.endsWith(".jsonl")) && !f.endsWith("：类型配置.json")
  ).map(f => join(dir, f));
}

// 加载所有类型定义（扫描各数据文件夹）
function loadAllTypes() {
  const types = {};
  const scanDirs = [DATA, ROOT];
  for (const baseDir of scanDirs) {
    if (!existsSync(baseDir)) continue;
    for (const dirName of readdirSync(baseDir)) {
      const dirPath = join(baseDir, dirName);
      try { if (!statSync(dirPath).isDirectory()) continue; } catch(e) { continue; }
      const files = readdirSync(dirPath).filter(f => f.endsWith("：类型配置.json"));
      for (const f of files) {
        const configPath = join(dirPath, f);
        const td = readJson(configPath);
        if (td && td.key) {
          td._configPath = configPath; // 保存配置文件路径，用于自动修复
          types[td.key] = td;
        }
      }
    }
  }
  return types;
}
const types = loadAllTypes();

const errors = [];
const fixed = [];

function addError(category, msg, fixFn) {
  errors.push({ category, msg, fixFn });
}

// ============================================================
// 1. 结构检查
// ============================================================
function checkStructure() {
  // 1.1 类型定义是否已加载（扫描时自动验证存在性）
  // types已经是加载好的类型定义对象，不需要再检查文件存在性

  // 1.2 存储路径是否存在
  for (const [key, info] of Object.entries(types)) {
    const storage = info.storage;
    if (storage && !existsSync(storage) && !existsSync(dirname(storage))) {
      addError("structure", `存储路径无效：${key} → ${storage} 不存在`);
    }
  }

  // 1.3 JSONL文件格式检查
  for (const [key, info] of Object.entries(types)) {
    const storage = info.storage;
    if (!storage || !storage.endsWith(".jsonl") || !existsSync(storage)) continue;

    const content = readFileSync(storage, "utf8");

    // 如果是JSON数组，自动转为JSONL
    if (content.trim().startsWith("[")) {
      addError("structure", `${key}：文件是JSON数组格式，应转为JSONL`, () => {
        const arr = JSON.parse(content);
        writeJsonl(storage, arr);
        return `已将 ${info.file.replace('.json','')} 从JSON数组转为JSONL（${arr.length}条）`;
      });
      continue;
    }

    // 检查每行是否合法JSON
    const lines = content.split("\n").filter(l => l.trim());
    let invalidLines = 0;
    for (const line of lines) {
      try { JSON.parse(line); }
      catch (e) { invalidLines++; }
    }
    if (invalidLines > 0) {
      addError("structure", `${key}：JSONL有${invalidLines}行解析失败`);
    }
  }

  // 1.4 dateField 完整性检查（配置驱动，缺失则自动扫描数据文件补充）
  const dateCandidates = ["startTime", "time", "date", "dueDate", "remindTime", "createdAt", "completedAt"];
  for (const [key, info] of Object.entries(types)) {
    if (info.dateField) continue; // 已声明，跳过

    const storage = info.storage;
    if (!storage) continue;

    // 找到数据文件
    let filepath = null;
    if (storage.endsWith(".jsonl")) {
      filepath = join(ROOT, storage);
    } else {
      const dir = join(ROOT, storage);
      if (existsSync(dir)) {
        const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
        if (files.length) filepath = join(dir, files[0]);
      }
    }

    if (!filepath || !existsSync(filepath)) continue;

    // 扫描数据文件，统计各日期字段出现频率
    const fieldCount = {};
    let total = 0;
    for (const line of readFileSync(filepath, "utf8").split("\n").filter(l => l.trim())) {
      try {
        const rec = JSON.parse(line);
        const c = rec.data || rec;
        total++;
        for (const f of dateCandidates) {
          if (c[f]) fieldCount[f] = (fieldCount[f] || 0) + 1;
        }
      } catch (e) { /* 跳过坏行 */ }
    }

    if (total === 0) continue;

    // 取出现频率最高的字段
    const sorted = Object.entries(fieldCount).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) continue;

    const bestField = sorted[0][0];
    const bestCount = sorted[0][1];

    addError("structure", `${key}：类型配置缺少dateField，扫描数据文件发现实际使用${bestField}（${bestCount}/${total}条）`, () => {
      // 自动补充dateField到类型配置
      const configPath = info._configPath;
      if (configPath && existsSync(configPath)) {
        const config = readJson(configPath);
        if (config) {
          config.dateField = bestField;
          writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
          return `已为 ${key} 补充 dateField=${bestField}`;
        }
      }
      return `无法自动补充 ${key} 的 dateField`;
    });
  }
}

// ============================================================
// 2. 重复ID检查
// ============================================================
function loadAllRecords() {
  const all = {};
  for (const [key, info] of Object.entries(types)) {
    const storage = info.storage;
    if (!storage) continue;

    if (storage.endsWith(".jsonl")) {
      all[key] = readJsonl(storage);
    } else if (existsSync(storage) && statSync(storage).isDirectory()) {
      let files = listJsonFiles(storage);
      // 也包含已归档/已转化
      const archiveDir = join(storage, "待办任务：已归档");
      const convertedDir = join(storage, "收集箱：已转化");
      if (existsSync(archiveDir)) files = files.concat(listJsonFiles(archiveDir));
      if (existsSync(convertedDir)) files = files.concat(listJsonFiles(convertedDir));
      all[key] = files.flatMap(f => {
        if (f.endsWith(".jsonl")) return readJsonl(f);
        const r = readJson(f);
        return r ? [r] : [];
      });
    }
  }
  return all;
}

function checkDuplicateIds(allRecords) {
  for (const [key, records] of Object.entries(allRecords)) {
    const idCount = {};
    for (const r of records) {
      if (r.id) idCount[r.id] = (idCount[r.id] || 0) + 1;
    }
    for (const [id, count] of Object.entries(idCount)) {
      if (count > 1) {
        addError("fields", `${key}：重复ID ${id}（出现${count}次）`);
      }
    }
  }
}

// ============================================================
// 3. 关联ID存在性检查（悬空引用）
// ============================================================
function checkRelations(allRecords) {
  // 构建所有ID的索引
  const allIds = new Set();
  for (const records of Object.values(allRecords)) {
    for (const r of records) {
      if (r.id) allIds.add(r.id);
    }
  }

  const relationFields = ["projectId", "completedActivityId", "archivedFromTask", "convertedFrom"];
  const listFields = ["peopleIds", "activityIds"];

  for (const [key, records] of Object.entries(allRecords)) {
    for (const r of records) {
      // 检查data里和根级别的关联字段
      const sources = [r, r.data || {}];
      for (const src of sources) {
        for (const field of relationFields) {
          const val = src[field];
          if (val && typeof val === "string" && !allIds.has(val)) {
            addError("relations", `${key} ${r.id}：${field}=${val}，但该记录不存在（悬空引用）`);
          }
        }
        for (const field of listFields) {
          const val = src[field];
          if (val && typeof val === "string") {
            const ids = val.split(",").map(s => s.trim()).filter(s => s);
            for (const id of ids) {
              if (!allIds.has(id)) {
                addError("relations", `${key} ${r.id}：${field}包含不存在的ID ${id}`);
              }
            }
          }
        }
      }
    }
  }
}

// ============================================================
// 主流程
// ============================================================
console.log("=== 数据检查报告（系统级）===");
console.log(`检查时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
console.log(`模式：${FIX ? "检查+自动修复" : "仅检查"}`);
console.log("");

checkStructure();
const allRecords = loadAllRecords();
checkDuplicateIds(allRecords);
checkRelations(allRecords);

// 执行自动修复
if (FIX && errors.length > 0) {
  console.log("--- 执行自动修复 ---");
  for (const err of errors) {
    if (err.fixFn) {
      try {
        const result = err.fixFn();
        fixed.push(result);
        console.log(`  🔧 ${result}`);
      } catch (e) {
        console.log(`  ❌ 修复失败：${err.msg} - ${e.message}`);
      }
    }
  }
  console.log("");
}

// 输出结果
const autoFixable = errors.filter(e => e.fixFn);
const needConfirm = errors.filter(e => !e.fixFn);

console.log(`🔧 可自动修复：${autoFixable.length}项`);
console.log(`⚠️ 需人工确认：${needConfirm.length}项`);
console.log("");

if (autoFixable.length > 0 && !FIX) {
  console.log("--- 可自动修复（运行 --fix 执行）---");
  autoFixable.forEach((e, i) => console.log(`${i + 1}. [${e.category}] ${e.msg}`));
  console.log("");
}

if (needConfirm.length > 0) {
  console.log("--- 需人工确认 ---");
  needConfirm.forEach((e, i) => console.log(`${i + 1}. [${e.category}] ${e.msg}`));
  console.log("");
}

console.log("--- 下一步 ---");
console.log("用户级检查（字段规范、未知字段、data包装、业务逻辑）请由AI根据 数据检查规范.md 执行。");
console.log("");

process.exit(needConfirm.length > 0 ? 1 : 0);
