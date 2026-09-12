#!/usr/bin/env node
/**
 * 双向关联自动发现检查工具（只读，不修改任何数据）
 * 用法: node 能力/数据检查/关联检查.mjs
 *
 * 核心逻辑：不硬编码任何类型和关联字段。
 * 1. 扫描 数据/ 下所有「类型配置.json」自动发现数据类型
 * 2. 加载所有记录，构建 ID 索引
 * 3. 遍历所有字段值，自动发现跨类型 ID 引用
 * 4. 检查反向引用是否存在，报告双向一致性错误
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const DATA = join(ROOT, "数据");

// ============================================================
// 加载所有类型配置
// ============================================================
function discoverTypes() {
  const types = [];
  for (const dir of readdirSync(DATA, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const configFiles = readdirSync(join(DATA, dir.name)).filter((f) =>
      f.endsWith("：类型配置.json")
    );
    for (const cf of configFiles) {
      try {
        const config = JSON.parse(readFileSync(join(DATA, dir.name, cf), "utf8"));
        types.push({ ...config, dir: dir.name });
      } catch (e) {
        console.error(`⚠ 读取类型配置失败: ${dir.name}/${cf}: ${e.message}`);
      }
    }
  }
  return types;
}

// ============================================================
// 数据加载
// ============================================================
function resolvePath(config) {
  const s = config.storage;
  if (s.startsWith("数据/")) return join(ROOT, s);
  return join(DATA, config.dir, s);
}

function loadRecords(config) {
  const basePath = resolvePath(config);
  if (!existsSync(basePath)) return [];

  const records = [];

  if (statSync(basePath).isDirectory()) {
    for (const f of readdirSync(basePath)) {
      if (f.endsWith(".json") && !f.endsWith("：类型配置.json")) {
        try {
          const raw = JSON.parse(readFileSync(join(basePath, f), "utf8"));
          if (raw.id) records.push({ id: raw.id, raw });
        } catch (e) {
          /* ignore parse errors */
        }
      }
    }
  } else if (basePath.endsWith(".jsonl")) {
    const lines = readFileSync(basePath, "utf8").split("\n").filter((l) => l.trim());
    for (const l of lines) {
      try {
        const raw = JSON.parse(l);
        if (raw.id) records.push({ id: raw.id, raw });
      } catch (e) {
        /* ignore */
      }
    }
  }

  return records;
}

function loadArchived(config) {
  if (!config.archiveStorage) return [];
  const archivePath = join(DATA, config.archiveStorage.replace(/^data\//, ""));
  if (!existsSync(archivePath)) return [];

  const records = [];
  if (statSync(archivePath).isDirectory()) {
    for (const f of readdirSync(archivePath)) {
      if (f.endsWith(".json") && !f.endsWith("：类型配置.json")) {
        try {
          const raw = JSON.parse(readFileSync(join(archivePath, f), "utf8"));
          if (raw.id) records.push({ id: raw.id, raw });
        } catch (e) {
          /* ignore */
        }
      }
    }
  } else if (archivePath.endsWith(".jsonl")) {
    const lines = readFileSync(archivePath, "utf8").split("\n").filter((l) => l.trim());
    for (const l of lines) {
      try {
        const raw = JSON.parse(l);
        if (raw.id) records.push({ id: raw.id, raw });
      } catch (e) {
        /* ignore */
      }
    }
  }
  return records;
}

// ============================================================
// 从一条记录中提取所有字符串值（递归展开嵌套对象+数组）
// ============================================================
function extractStrings(obj, path = "") {
  const results = [];
  if (!obj || typeof obj !== "object") return results;

  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === "string") {
      results.push({ path: p, value: v });
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") {
          results.push({ path: p, value: item });
        }
      }
    } else if (typeof v === "object" && v !== null) {
      results.push(...extractStrings(v, p));
    }
  }
  return results;
}

// ============================================================
// 核心检查
// ============================================================
export function runRelationChecks() {
  const errors = [];
  const warnings = [];

  // 1. 发现所有类型
  const typeConfigs = discoverTypes();
  console.log("发现类型:", typeConfigs.map((t) => `${t.key}(${t.name})`).join(", "));

  // 2. 加载所有数据
  const allRecords = [];
  const typeMap = {};

  for (const cfg of typeConfigs) {
    const records = loadRecords(cfg);
    const archived = loadArchived(cfg);
    const all = [...records, ...archived];
    typeMap[cfg.key] = { config: cfg, records: all };
    allRecords.push(...all.map((r) => ({ ...r, typeKey: cfg.key })));
    console.log(`  ${cfg.key} (${cfg.name}): ${all.length} 条记录`);
  }

  console.log("");

  // 3. 构建 ID 索引
  const idMap = new Map();
  for (const r of allRecords) {
    idMap.set(r.id, { typeKey: r.typeKey, record: r });
  }
  console.log(`总记录数: ${allRecords.length}, 唯一 ID 数: ${idMap.size}`);

  // 4. 自动发现所有跨类型 ID 引用
  const allRefs = [];

  for (const r of allRecords) {
    const strings = extractStrings(r.raw);
    for (const { path, value } of strings) {
      // 检查单值
      if (idMap.has(value) && value !== r.id) {
        const target = idMap.get(value);
        if (target.typeKey !== r.typeKey) {
          allRefs.push({
            fromType: r.typeKey,
            fromId: r.id,
            field: path,
            refType: target.typeKey,
            refId: value,
          });
        }
      }
      // 检查逗号分隔的多值
      const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1) {
        for (const part of parts) {
          if (idMap.has(part) && part !== r.id) {
            const target = idMap.get(part);
            if (target.typeKey !== r.typeKey) {
              allRefs.push({
                fromType: r.typeKey,
                fromId: r.id,
                field: path,
                refType: target.typeKey,
                refId: part,
                isMultiValue: true,
              });
            }
          }
        }
      }
    }
  }

  console.log(`发现的跨类型引用: ${allRefs.length}`);

  // 5. 构建反向引用索引
  const refMap = new Map();
  for (const ref of allRefs) {
    if (!refMap.has(ref.fromId)) refMap.set(ref.fromId, new Set());
    refMap.get(ref.fromId).add(ref.refId);
  }

  // 6. 双向一致性检查
  for (const ref of allRefs) {
    const bRefs = refMap.get(ref.refId);
    if (!bRefs || !bRefs.has(ref.fromId)) {
      errors.push(
        `[${ref.fromType}→${ref.refType}] ${ref.fromId} (${ref.field} → ${ref.refId})，但 ${ref.refType} 没有反向引用 ${ref.fromType}.${ref.fromId}`
      );
    }
  }

  // 7. 按方向分组统计
  const refsByDir = {};
  for (const ref of allRefs) {
    const key = `${ref.fromType}↔${ref.refType}`;
    if (!refsByDir[key]) refsByDir[key] = { forward: 0, backward: 0 };
    refsByDir[key].forward++;
  }
  // 反向引用也计入
  for (const ref of allRefs) {
    const key = `${ref.refType}↔${ref.fromType}`;
    if (!refsByDir[key]) refsByDir[key] = { forward: 0, backward: 0 };
    refsByDir[key].backward++;
  }

  // 8. 输出汇总
  console.log("");

  const dirKeys = Object.keys(refsByDir).sort();
  if (dirKeys.length > 0) {
    console.log("关联方向:");
    for (const key of dirKeys) {
      const d = refsByDir[key];
      console.log(
        `  ${key}: ${d.forward}条正向, ${d.backward}条反向`
      );
    }
    console.log("");
  }

  console.log("=== 双向一致性检查结果 ===");
  if (errors.length === 0) {
    console.log("✅ 所有双向关联一致！");
  } else {
    console.log(`错误数: ${errors.length}`);
    for (const e of errors) {
      console.log(`  ✗ ${e}`);
    }
  }

  if (warnings.length > 0) {
    console.log("\n警告:");
    for (const w of warnings) {
      console.log(`  ⚠ ${w}`);
    }
  }

  console.log(
    '\n⚠️ 提交铁律：所有 git 提交必须通过 `node 能力/提交并确认.mjs "提交信息"` 执行，禁止直接 git add/commit/push。'
  );

  return { errors, warnings };
}

// ============================================================
// 独立运行入口
// ============================================================
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const result = runRelationChecks();
  if (result.errors.length > 0) {
    process.exit(1);
  }
}