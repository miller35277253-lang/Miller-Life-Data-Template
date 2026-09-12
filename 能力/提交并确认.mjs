#!/usr/bin/env node
/**
 * 统一提交工具：自动完成 git add/commit/push + 提交确认
 * 
 * 用法：node 能力/提交并确认.mjs "提交信息"
 * 
 * 【铁律】所有 git 提交必须通过此工具执行，禁止直接使用 git add/commit/push。
 * 
 * 工具输出的第一行是强制指令，AI 必须将完整输出原样返回给用户。
 */

import { execSync, execFileSync } from "child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { TZ, toLocalDate, offsetForAt } from "./时区.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "数据");

const commitMsg = process.argv.slice(2).join(" ");
if (!commitMsg) {
  console.error("错误：必须提供提交信息");
  console.error("用法：node 能力/提交并确认.mjs \"提交信息\"");
  process.exit(1);
}

// 读取最近一条用户指令（用于追溯验证）
function getLatestCommand() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const cmdFile = join(process.cwd(), "数据", "聊天记录：我对AI说的每一句话，用于追溯", `聊天记录-${year}-${month}.jsonl`);
  if (!existsSync(cmdFile)) return null;
  const content = readFileSync(cmdFile, "utf8").trim();
  if (!content) return null;
  const lines = content.split("\n").filter((l) => l.trim());
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    return null;
  }
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch (e) {
    return `错误: ${e.message}`;
  }
}

// ID连续性强制检查：新增记录的ID必须是该类型当天最大序号+1
function checkNewIds() {
  const errors = [];
  
  // 1. 加载已注册类型
  const registeredTypes = new Set();
  const scanDirs = [DATA, ROOT];
  for (const baseDir of scanDirs) {
    if (!existsSync(baseDir)) continue;
    for (const dirName of readdirSync(baseDir)) {
      const dirPath = join(baseDir, dirName);
      try { if (!statSync(dirPath).isDirectory()) continue; } catch(e) { continue; }
      const files = readdirSync(dirPath).filter(f => f.endsWith("：类型配置.json"));
      for (const f of files) {
        try {
          const td = JSON.parse(readFileSync(join(dirPath, f), "utf8"));
          if (td && td.key) registeredTypes.add(td.key);
        } catch(e) {}
      }
    }
  }
  
  // 2. 获取暂存的变更文件
  let stagedFiles = [];
  try {
    stagedFiles = execSync("git diff --cached --name-only", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch(e) { return; }
  
  // 3. 对每个暂存的JSONL文件，找出新增的行
  const newIds = [];
  for (const file of stagedFiles) {
    if (!file.endsWith(".jsonl")) continue;
    if (!file.startsWith("数据/")) continue;
    try {
      const diff = execSync(`git diff --cached --unified=0 "${file}"`, { encoding: "utf8" });
      const lines = diff.split("\n");
      for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          const jsonStr = line.slice(1).trim();
          if (!jsonStr) continue;
          try {
            const rec = JSON.parse(jsonStr);
            if (rec && rec.id) newIds.push({ id: rec.id, file, rec });
          } catch(e) {}
        }
      }
    } catch(e) {}
  }
  
  // 4. 检查每个新增ID
  for (const { id, file, rec } of newIds) {
    // 解析ID格式：<类型>-<YYYYMMDD>-<5位序号>
    const match = id.match(/^(.+)-(\d{8})-(\d{5})$/);
    if (!match) {
      errors.push(`✗ ID格式错误: ${id} (文件: ${file})，应为 <类型>-<YYYYMMDD>-<5位序号>`);
      continue;
    }
    const [, typeKey, dateStr, seqStr] = match;
    const seq = parseInt(seqStr, 10);
    
    // 时区强校验：记录自身时间戳必须符合「个人档案.json」的时区，且 ID 日期 = 该时间在档案时区的本地日期
    const rawTime = rec?.data?.time || rec?.data?.startTime;
    if (rawTime) {
      const rt = String(rawTime);
      const localDate = toLocalDate(rt); // 按档案时区换算 (个人档案.json timezone)
      const expectDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
      const offsetPattern = /^([+-]\d{2}:\d{2})$/;
      const mOffset = offsetPattern.exec(rt.length >= 25 ? rt.slice(19, 25) : "");
      const expectOffset = offsetForAt(rt); // 该时刻在档案时区下的正确偏移
      if (!localDate || !mOffset) {
        errors.push(`✗ 时间戳格式/日期无法解析: ${id} (文件: ${file})，时间为 "${rt}"`);
        errors.push(`  → 请携带标准偏移（如同 ${expectOffset}）并按个人档案时区 ${TZ} 填写`);
      } else if (mOffset[1] !== expectOffset) {
        errors.push(`✗ 时间戳时区偏移不符: ${id} (文件: ${file})`);
        errors.push(`  → 个人档案时区 = ${TZ}，此时刻正确偏移应为 ${expectOffset}；实际携带 ${mOffset[1]}`);
      } else if (localDate !== expectDate) {
        errors.push(`✗ ID日期与记录时间不符（需按档案时区 ${TZ} 判断）: ${id} (文件: ${file})`);
        errors.push(`  → 记录时间 "${rt}" 在档案时区下对应日期是 ${localDate}，而 ID 写的是 ${expectDate}`);
        errors.push(`  → 请用 "node 能力/数据工具.mjs nextid ${typeKey}" 重新生成（它现在以档案时区为准）`);
      }
    }
    
    // 检查类型是否已注册
    if (!registeredTypes.has(typeKey)) {
      errors.push(`✗ 类型未注册: ${typeKey} (ID: ${id}, 文件: ${file})`);
      errors.push(`  → 请检查是否真的需要创建此分类。如必要，请先创建类型配置文件（*：类型配置.json），注册后使用 "node 能力/数据工具.mjs nextid ${typeKey}" 生成ID再提交。`);
      continue;
    }
    
    // 检查序号是否正好是最大序号+1
    // 读取该类型的存储文件，找当天最大序号
    let maxSeq = 0;
    // 从文件路径推断存储路径，或直接扫描data目录
    const fullPath = join(ROOT, file);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf8");
        const prefix = `${typeKey}-${dateStr}-`;
        const allLines = content.split("\n").filter(l => l.trim());
        for (const l of allLines) {
          try {
            const r = JSON.parse(l);
            if (r.id && r.id.startsWith(prefix)) {
              const s = parseInt(r.id.slice(prefix.length), 10);
              if (!Number.isNaN(s)) maxSeq = Math.max(maxSeq, s);
            }
          } catch(e) {}
        }
      } catch(e) {}
    }
    
    if (seq !== maxSeq + 1) {
      errors.push(`✗ ID序号不连续: ${id} (文件: ${file})`);
      errors.push(`  → 当前类型 ${typeKey} 当天最大序号是 ${maxSeq}，新增记录应为 ${typeKey}-${dateStr}-${String(maxSeq + 1).padStart(5, "0")}`);
      errors.push(`  → 请使用 "node 能力/数据工具.mjs nextid ${typeKey}" 生成正确ID后再提交。禁止凭想象分配ID。`);
    }
  }
  
  if (errors.length) {
    console.error("\n" + "❌".repeat(20));
    console.error("❌ 提交失败！ID连续性检查未通过 ❌");
    console.error("❌".repeat(20));
    for (const e of errors) console.error(e);
    console.error("");
    process.exit(1);
  }
}

// 时间溯源强制检查：任何带 startTime/time 的新记录必须有 timeSource
// 如果 timeSource 是一个已知ID，验证时间是否匹配。否则只要求非空。
// 不硬编码类型、不硬编码字段名、自动提取参考记录的所有时间。
function checkTimeSource() {
  const errors = [];
  
  // 加载所有数据，构建全量 ID 索引（复用关联检查的逻辑）
  function loadAllTypesAndBuildIdMap() {
    const idMap = new Map();
    
    // 发现所有类型配置
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
          } catch (e) { /* ignore */ }
        }
      }
      return types;
    }
    
    // 解析路径
    function resolvePath(config) {
      const s = config.storage;
      if (s.startsWith("数据/")) return join(ROOT, s);
      return join(DATA, config.dir, s);
    }
    
    // 加载记录
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
            } catch (e) { /* ignore */ }
          }
        }
      } else if (basePath.endsWith(".jsonl")) {
        const lines = readFileSync(basePath, "utf8").split("\n").filter((l) => l.trim());
        for (const l of lines) {
          try {
            const raw = JSON.parse(l);
            if (raw.id) records.push({ id: raw.id, raw });
          } catch (e) { /* ignore */ }
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
            } catch (e) { /* ignore */ }
          }
        }
      } else if (archivePath.endsWith(".jsonl")) {
        const lines = readFileSync(archivePath, "utf8").split("\n").filter((l) => l.trim());
        for (const l of lines) {
          try {
            const raw = JSON.parse(l);
            if (raw.id) records.push({ id: raw.id, raw });
          } catch (e) { /* ignore */ }
        }
      }
      return records;
    }
    
    // 主流程
    const typeConfigs = discoverTypes();
    for (const cfg of typeConfigs) {
      const records = loadRecords(cfg);
      const archived = loadArchived(cfg);
      const all = [...records, ...archived];
      for (const r of all) {
        idMap.set(r.id, r.raw);
      }
    }
    
    // 辅助：尝试解析时间为时间戳（兼容各种格式、时区）
    // 如果是纯时间 "15:00"，用 refTimeStr（完整ISO字符串）补全日期和时区
    function tryParseTime(str, refTimeStr = null) {
      try {
        // 纯时间格式："15:00" 或 "15:00:00"
        const timeMatch = str.trim().match(/^(\d{1,2}):(\d{2})(:(\d{2}))?$/);
        if (timeMatch && refTimeStr) {
          // 用档案时区，把 refTimeStr 的日期和纯时间组合
          const localDate = toLocalDate(refTimeStr);
          if (!localDate) return null;
          const offset = offsetForAt(refTimeStr);
          const h = String(parseInt(timeMatch[1],10)).padStart(2,"0");
          const m = String(parseInt(timeMatch[2],10)).padStart(2,"0");
          const s = timeMatch[4] ? String(parseInt(timeMatch[4],10)).padStart(2,"0") : "00";
          const d = new Date(`${localDate}T${h}:${m}:${s}${offset}`);
          if (isNaN(d.getTime())) return null;
          return d.getTime();
        }
        if (timeMatch) {
          // 没有 refTimeStr，无法补全，跳过
          return null;
        }
        // 完整日期时间格式
        const d = new Date(str);
        if (isNaN(d.getTime())) return null;
        return d.getTime();
      } catch(e) {
        return null;
      }
    }
    
    return { idMap, tryParseTime };
  }
  
  let stagedFiles = [];
  try {
    const raw = execSync("git diff --cached --name-only -z", { encoding: "utf8" });
    stagedFiles = raw.split("\0").filter(Boolean);
  } catch(e) { return; }
  
  // 预先加载全量 ID 索引
  const { idMap, tryParseTime } = loadAllTypesAndBuildIdMap();
  
  for (const file of stagedFiles) {
    if (!file.endsWith(".jsonl")) continue;
    if (!file.startsWith("数据/")) continue;
    
    try {
      const diff = execSync(`git diff --cached --unified=0 -- "${file}"`, { encoding: "utf8" });
      const diffLines = diff.split("\n");

      // 第一遍：收集所有被删除/修改行的 ID（- 行）
      // 如果一个 + 行的 ID 在 - 行里出现过，说明是修改已有记录（删旧行+增新行），不是真正的新增
      const modifiedIds = new Set();
      for (const line of diffLines) {
        if (line.startsWith("-") && !line.startsWith("---")) {
          const jsonStr = line.slice(1).trim();
          if (jsonStr) {
            try { modifiedIds.add(JSON.parse(jsonStr).id); } catch (e) {}
          }
        }
      }

      // 第二遍：只检查真正的新增记录
      for (const line of diffLines) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          const jsonStr = line.slice(1).trim();
          if (!jsonStr) continue;
          try {
            const rec = JSON.parse(jsonStr);
            // 跳过：修改已有记录（ID在删除行里出现过）
            if (rec.id && modifiedIds.has(rec.id)) continue;
            // 跳过：command 类型（时间由保存指令工具自动生成，不需要 timeSource）
            // command 记录可能没有 type 字段，用 ID 前缀判断
            if (rec.type === "command" || (rec.id && String(rec.id).startsWith("command-"))) continue;

            const container = rec && rec.data ? rec.data : rec;
            if (!container) continue;

            const timeField = container.startTime || container.time;
            if (!timeField) continue; // 没有时间字段，不检查

            const source = container.timeSource;
            if (!source || (typeof source === "string" && source.trim() === "")) {
              errors.push({
                type: "missing",
                id: rec.id || "未知",
                file,
                time: timeField
              });
              continue;
            }

            // timeSource 是一个已知 ID → 验证时间匹配
            const sourceId = source.trim();
            if (idMap.has(sourceId)) {
              const refRecord = idMap.get(sourceId);
              if (refRecord === rec.raw) {
                // 自引用，跳过验证
                continue;
              }

              // 如果 timeSource == commandId，说明时间是从用户原始语句解析的
              // （如用户说"明天下午6点"、"刚刚"），command 里是自然语言，无法自动匹配时间值
              // 只验证 commandId 存在即可（由 checkCommandIdExists 负责），此处跳过自动时间匹配
              if (container.commandId && sourceId === container.commandId.trim()) {
                continue;
              }

              // 否则：时间是从另一条历史记录衔接来的（如散步结束=工作开始）
              // 提取参考记录的时间字段，验证是否匹配
              const candidates = extractTimeFields(refRecord);
              const newTimeMs = tryParseTime(timeField);
              
              if (newTimeMs === null) {
                // 新记录时间格式无法解析，报错
                errors.push({
                  type: "invalid_time",
                  id: rec.id || "未知",
                  file,
                  time: timeField,
                  sourceId
                });
                continue;
              }
              
              // 检查是否匹配任何一个候选时间
              let matched = false;
              for (const cand of candidates) {
                // 用新记录的时间字符串作为参考补全纯时间格式
                const candMs = tryParseTime(cand, timeField);
                if (candMs === null) continue;
                // 允许 ±60秒误差（应对不同精度）
                if (Math.abs(newTimeMs - candMs) <= 60000) {
                  matched = true;
                  break;
                }
              }
              
              if (!matched) {
                errors.push({
                  type: "mismatch",
                  id: rec.id || "未知",
                  file,
                  time: timeField,
                  sourceId
                });
              }
            }
            // 查不到 ID → 当作用户口述，不验证，只要求非空
          } catch(e) {}
        }
      }
    } catch(e) {}
  }
  
  if (errors.length === 0) return;
  
  console.log("\n" + "❌".repeat(20));
  console.log("❌ 提交失败！时间溯源检查未通过 ❌");
  console.log("❌".repeat(20) + "\n");
  
  for (const e of errors) {
    if (e.type === "missing") {
      console.log(`  记录: ${e.id} (${e.file})`);
      console.log(`  时间: ${e.time}`);
      console.log(`  错误: 缺少 timeSource 字段`);
      console.log("  规则：新增记录包含时间，必须说明时间来源");
    } else if (e.type === "invalid_time") {
      console.log(`  记录: ${e.id} (${e.file})`);
      console.log(`  时间: ${e.time}`);
      console.log(`  timeSource: ${e.sourceId}`);
      console.log(`  错误: 新记录时间格式无法解析`);
    } else if (e.type === "mismatch") {
      console.log(`  记录: ${e.id} (${e.file})`);
      console.log(`  时间: ${e.time}`);
      console.log(`  timeSource: ${e.sourceId}`);
      console.log(`  错误: 时间不匹配 —— 参考记录 ${e.sourceId} 中没有找到与这个时间相近的值`);
    }
    console.log("");
  }
  
  console.log("→ 规则：");
  console.log("  1. 任何带 startTime/time 的新增记录，必须有非空 timeSource");
  console.log("  2. 如果 timeSource 是一个已存在的 ID，程序自动验证时间是否匹配");
  console.log("  3. 如果 timeSource 不是 ID（如 user:下午3点），跳过验证，由人工核对");
  console.log("");
  console.log("→ 写法示例：");
  console.log("  \"timeSource\": \"task-20260904-00001\"    直接写参考记录 ID（推荐）");
  console.log("  \"timeSource\": \"user:下午3点出发\"          用户口头说明时间");
  console.log("");
  process.exit(1);
}

// ============================================
// 聊天记录完整性校验：防止 AI 绕过保存指令工具直接编辑聊天记录文件
// 校验：id格式、time格式（必须带时区偏移）、content非空、source非空、当天ID连续
// ============================================
function checkCommandIntegrity() {
  const errors = [];
  let stagedFiles = [];
  try {
    const raw = execSync("git diff --cached --name-only -z", { encoding: "utf8" });
    stagedFiles = raw.split("\0").filter(Boolean);
  } catch (e) { return; }

  const commandFiles = stagedFiles.filter((f) =>
    f.startsWith("数据/") && f.includes("聊天记录") && f.endsWith(".jsonl")
  );

  for (const file of commandFiles) {
    try {
      const diff = execSync(`git diff --cached --unified=0 -- "${file}"`, { encoding: "utf8" });
      const addedLines = [];
      const removedIds = new Set();
      for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          const jsonStr = line.slice(1).trim();
          if (jsonStr) addedLines.push(jsonStr);
        }
        if (line.startsWith("-") && !line.startsWith("---")) {
          const jsonStr = line.slice(1).trim();
          if (jsonStr) {
            try { removedIds.add(JSON.parse(jsonStr).id); } catch (e) {}
          }
        }
      }

      const todaySeqs = new Set();
      // 加载同文件中所有command，用于reply的commandId校验
      const allCommandsInFile = new Map();
      try {
        const fullPath = join(ROOT, file);
        if (existsSync(fullPath)) {
          const allLines = readFileSync(fullPath, "utf8").split("\n").filter(l => l.trim());
          for (const l of allLines) {
            try {
              const r = JSON.parse(l);
              if (r.type === "command" && r.id) {
                allCommandsInFile.set(r.id, r);
              }
            } catch(e) {}
          }
        }
      } catch(e) {}

      for (const jsonStr of addedLines) {
        try {
          const rec = JSON.parse(jsonStr);
          // 跳过删除后重新添加的同ID记录（修改场景）
          if (removedIds.has(rec.id)) continue;

          const isCommand = rec.type === "command" || (rec.id && String(rec.id).startsWith("command-"));
          const isReply = rec.type === "reply" || (rec.id && String(rec.id).startsWith("reply-"));

          // id 格式（支持command和reply两种）
          const idPattern = /^(command|reply)-\d{8}-\d{5}$/;
          if (!rec.id || !idPattern.test(rec.id)) {
            errors.push({ file, id: rec.id || "未知", issue: "id格式不符合 command-YYYYMMDD-XXXXX 或 reply-YYYYMMDD-XXXXX" });
            continue;
          }
          // time 格式（必须带时区偏移，不能是纯UTC或纯日期）
          if (!rec.time || !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/.test(rec.time)) {
            errors.push({ file, id: rec.id, issue: `time格式不符合规范（必须带时区偏移，如 2026-09-07T15:20:00+08:00），当前值: ${rec.time}` });
          }
          // content 非空
          if (!rec.content || !rec.content.trim()) {
            errors.push({ file, id: rec.id, issue: "content为空（必须包含原文内容）" });
          }
          // source 非空
          if (!rec.source || !rec.source.trim()) {
            errors.push({ file, id: rec.id, issue: "source为空（必须标记来源）" });
          }

          // reply特有检查
          if (isReply) {
            // reply必须带commandId
            if (!rec.commandId || !String(rec.commandId).trim()) {
              errors.push({ file, id: rec.id, issue: "reply类型必须带commandId字段，指向对应的用户输入" });
            } else {
              // commandId必须存在
              if (!allCommandsInFile.has(rec.commandId)) {
                errors.push({ file, id: rec.id, issue: `reply的commandId "${rec.commandId}" 在聊天记录中不存在` });
              } else {
                // reply的序号必须和commandId的序号一致
                const replyMatch = rec.id.match(/^reply-(\d{8})-(\d+)$/);
                const cmdMatch = rec.commandId.match(/^command-(\d{8})-(\d+)$/);
                if (replyMatch && cmdMatch) {
                  if (replyMatch[1] !== cmdMatch[1] || replyMatch[2] !== cmdMatch[2]) {
                    errors.push({ file, id: rec.id, issue: `reply的序号(${replyMatch[1]}-${replyMatch[2]})与commandId的序号(${cmdMatch[1]}-${cmdMatch[2]})不一致，同一轮对话序号必须相同` });
                  }
                }
              }
            }
          }

          // 收集当天序号用于连续性检查（command和reply分别统计）
          const m = rec.id.match(/^(command|reply)-(\d{8})-(\d+)$/);
          if (m) todaySeqs.add(`${m[1]}:${m[2]}:${parseInt(m[3], 10)}`);
        } catch (e) {
          errors.push({ file, id: "解析失败", issue: `JSON解析失败: ${jsonStr.slice(0, 60)}` });
        }
      }
    } catch (e) {}
  }

  if (errors.length === 0) return;

  console.log("\n" + "❌".repeat(20));
  console.log("❌ 提交失败！聊天记录完整性校验未通过 ❌");
  console.log("❌".repeat(20) + "\n");
  for (const e of errors) {
    console.log(`  文件: ${e.file}`);
    console.log(`  ID: ${e.id}`);
    console.log(`  问题: ${e.issue}`);
    console.log("");
  }
  console.log("→ 规则：聊天记录只能通过 `node 能力/保存指令.mjs` 写入，禁止直接编辑。");
  console.log("  保存用户输入：`node 能力/保存指令.mjs \"用户原话\"`");
  console.log("  保存AI回复（滞后存储）：`node 能力/保存指令.mjs --reply \"回复内容\" --command-id <commandId>`");
  console.log("  工具会自动生成符合规范的 id、time（带时区偏移）、source 字段，reply的序号与commandId相同。\n");
  process.exit(1);
}

// ============================================
// commandId 存在性校验：带时间的新增记录必须有 commandId，且该 commandId 必须存在于聊天记录中
// ============================================
function checkCommandIdExists() {
  const errors = [];
  const warnings = [];
  let stagedFiles = [];
  try {
    const raw = execSync("git diff --cached --name-only -z", { encoding: "utf8" });
    stagedFiles = raw.split("\0").filter(Boolean);
  } catch (e) { return; }

  // 加载所有聊天记录，构建 commandId 集合
  const commandIds = new Set();
  try {
    const cmdDir = join(ROOT, "数据", "聊天记录：我对AI说的每一句话，用于追溯");
    if (existsSync(cmdDir)) {
      for (const f of readdirSync(cmdDir)) {
        if (f.endsWith(".jsonl")) {
          const lines = readFileSync(join(cmdDir, f), "utf8").split("\n").filter((l) => l.trim());
          for (const l of lines) {
            try { commandIds.add(JSON.parse(l).id); } catch (e) {}
          }
        }
      }
    }
  } catch (e) {}

  // 检查暂存区所有 JSONL 数据文件（排除聊天记录本身）
  const dataFiles = stagedFiles.filter((f) =>
    f.startsWith("数据/") && f.endsWith(".jsonl") && !f.includes("聊天记录") && !f.includes("已转化")
  );

  for (const file of dataFiles) {
    try {
      const diff = execSync(`git diff --cached --unified=0 -- "${file}"`, { encoding: "utf8" });
      const addedRecs = [];
      const removedIds = new Set();
      for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          const jsonStr = line.slice(1).trim();
          if (jsonStr) {
            try { addedRecs.push(JSON.parse(jsonStr)); } catch (e) {}
          }
        }
        if (line.startsWith("-") && !line.startsWith("---")) {
          const jsonStr = line.slice(1).trim();
          if (jsonStr) {
            try { removedIds.add(JSON.parse(jsonStr).id); } catch (e) {}
          }
        }
      }

      for (const rec of addedRecs) {
        // 跳过修改已有记录（删除后重新添加同ID）
        if (removedIds.has(rec.id)) continue;

        const container = rec.data || rec;
        // 只检查带时间字段的记录
        if (!container.startTime && !container.time) continue;

        // 豁免：批量导入来源
        const meta = rec.meta || {};
        if (meta.source === "import") continue;

        const cmdId = container.commandId;
        if (!cmdId || !String(cmdId).trim()) {
          errors.push({
            file, id: rec.id || "未知",
            issue: "缺少 commandId 字段——新增带时间的记录必须关联用户原始指令（通过保存指令工具获取 commandId）",
          });
        } else if (!commandIds.has(cmdId)) {
          errors.push({
            file, id: rec.id || "未知",
            issue: `commandId "${cmdId}" 在聊天记录中不存在——请先调用保存指令工具保存用户原话，再用返回的 commandId`,
          });
        }
      }
    } catch (e) {}
  }

  if (errors.length === 0) return;

  console.log("\n" + "❌".repeat(20));
  console.log("❌ 提交失败！commandId 校验未通过 ❌");
  console.log("❌".repeat(20) + "\n");
  for (const e of errors) {
    console.log(`  文件: ${e.file}`);
    console.log(`  ID: ${e.id}`);
    console.log(`  问题: ${e.issue}`);
    console.log("");
  }
  console.log("→ 规则：新增带时间的记录必须先执行八步闭环第0步：");
  console.log("  1. 调用 `node 能力/保存指令.mjs \"用户原话\"` 保存指令，获取返回的 commandId");
  console.log("  2. 在记录的 data 容器中填入 commandId 字段");
  console.log("  3. 提交时程序自动验证 commandId 存在\n");
  process.exit(1);
}

// 只从已知时间字段提取候选值（替代之前的"递归所有字符串"，减少误报）
// 已知时间字段：startTime, endTime, time, dueDate, remindTime, createdAt, updatedAt, completedAt, firstDue, lastCompleted
const TIME_FIELD_NAMES = new Set([
  "startTime", "endTime", "time", "dueDate", "remindTime",
  "createdAt", "updatedAt", "completedAt", "firstDue", "lastCompleted",
  "lastWatering", "date", "datetime", "timestamp",
]);
function extractTimeFields(obj) {
  const candidates = [];
  function traverse(o, key) {
    if (!o) return;
    if (typeof o === "string") {
      if (key && TIME_FIELD_NAMES.has(key) && o.length >= 5) {
        candidates.push(o);
      }
      return;
    }
    if (typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        traverse(v, k);
      }
    }
  }
  traverse(obj, null);
  return candidates;
}

// 字段一致性检查：分层读取历史记录，判断新记录格式是否与主流一致
// 策略：先读3条不连续的记录，一致就用；不一致再读10条统计；差异太大说明类型本身不固定，跳过
// 只阻止"完全不用主流核心字段"的情况，允许正常新增字段
function checkFieldConsistency() {
  const errors = [];
  const warnings = [];
  
  // 获取暂存的变更文件（用-z选项避免中文文件名被八进制转义）
  let stagedFiles = [];
  try {
    const raw = execSync("git diff --cached --name-only -z", { encoding: "utf8" });
    stagedFiles = raw.split("\0").filter(Boolean);
  } catch(e) { return; }
  
  for (const file of stagedFiles) {
    if (!file.endsWith(".jsonl")) continue;
    if (!file.startsWith("数据/")) continue;
    
    try {
      // 找出新增的行（用--分隔路径，避免中文文件名解析失败）
      const diff = execSync(`git diff --cached --unified=0 -- "${file}"`, { encoding: "utf8" });
      const newRecords = [];
      for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          const jsonStr = line.slice(1).trim();
          if (!jsonStr) continue;
          try {
            const rec = JSON.parse(jsonStr);
            if (rec && rec.data) newRecords.push(rec);
          } catch(e) {}
        }
      }
      
      if (newRecords.length === 0) continue;
      
      // 分层读取历史记录
      const fullPath = join(ROOT, file);
      if (!existsSync(fullPath)) continue;
      
      const content = readFileSync(fullPath, "utf8");
      const allLines = content.split("\n").filter(l => l.trim());
      if (allLines.length < 5) continue; // 历史记录太少，不做检查
      
      // 第1层：读3条不连续的记录（最后1条、往前10条、往前50条）
      const sampleIndices = [
        allLines.length - 1,
        Math.max(0, allLines.length - 10),
        Math.max(0, allLines.length - 50)
      ].filter((v, i, a) => a.indexOf(v) === i); // 去重
      
      const sampleFields = sampleIndices.map(idx => {
        try {
          const r = JSON.parse(allLines[idx]);
          return r && r.data ? new Set(Object.keys(r.data)) : null;
        } catch(e) { return null; }
      }).filter(Boolean);
      
      let coreFields = null; // 核心字段集合
      
      // 如果3条记录字段完全一致，直接用这个格式
      const allSame = sampleFields.length >= 2 && 
        sampleFields.every(s => s.size === sampleFields[0].size && 
          Array.from(s).every(f => sampleFields[0].has(f)));
      
      if (allSame) {
        coreFields = sampleFields[0];
      } else {
        // 第2层：读最近10条统计频率
        const fieldFreq = {};
        let count = 0;
        const startIdx = Math.max(0, allLines.length - 10);
        for (let i = startIdx; i < allLines.length; i++) {
          try {
            const r = JSON.parse(allLines[i]);
            if (r && r.data) {
              count++;
              for (const f of Object.keys(r.data)) {
                fieldFreq[f] = (fieldFreq[f] || 0) + 1;
              }
            }
          } catch(e) {}
        }
        
        // 核心字段：出现频率>=80%的字段
        coreFields = new Set();
        for (const [f, c] of Object.entries(fieldFreq)) {
          if (c / count >= 0.8) coreFields.add(f);
        }
        
        // 如果核心字段太少（<3个），说明这个类型字段不固定，跳过检查
        if (coreFields.size < 3) continue;
      }
      
      // 检查每条新增记录
      for (const rec of newRecords) {
        const newFields = new Set(Object.keys(rec.data));
        // 缺少的核心字段
        const missingCore = Array.from(coreFields).filter(f => !newFields.has(f));
        
        if (missingCore.length >= 2) {
          // 缺少≥2个核心字段，大概率是格式错误，阻止
          errors.push({
            file,
            id: rec.id || "未知",
            missing: missingCore,
            newFields: Array.from(newFields),
            coreFields: Array.from(coreFields)
          });
        } else if (missingCore.length === 1) {
          // 只缺1个核心字段，可能是正常的，警告
          warnings.push({
            file,
            id: rec.id || "未知",
            missing: missingCore[0]
          });
        }
        // 新增字段不阻止，允许正常扩展
      }
    } catch(e) {}
  }
  
  // 先输出警告（不阻止）
  if (warnings.length > 0) {
    console.log("\n⚠️  字段一致性提醒（不阻止提交）：");
    for (const w of warnings) {
      console.log(`  ${w.id}: 缺少字段 "${w.missing}"，如果是正常情况可忽略`);
    }
    console.log("");
  }
  
  // 再输出错误（阻止提交）
  if (errors.length > 0) {
    console.log("\n" + "❌".repeat(20));
    console.log("❌ 提交失败！字段一致性检查未通过 ❌");
    console.log("❌".repeat(20));
    console.log("   原因：新增记录缺少多个历史核心字段，可能是格式错误。");
    console.log("   请打开文件查看几条历史记录，确认标准字段格式后再写入。\n");
    for (const e of errors) {
      console.log(`  文件: ${e.file}`);
      console.log(`  记录: ${e.id}`);
      console.log(`  缺少的核心字段: ${e.missing.join(", ")}`);
      console.log(`  你写的字段: ${e.newFields.join(", ")}`);
      console.log(`  历史核心字段: ${e.coreFields.join(", ")}`);
      console.log("");
    }
    console.log("→ 如果确实需要新增字段，请先确认不是拼写错误，然后用正确的核心字段+新字段重新写入。\n");
    process.exit(1);
  }
}

// 1. 记录提交前 hash
const beforeHash = run("git rev-parse HEAD");

// 2. 执行提交
// 提交时强制检查：ID连续性 + JSON结构合法性 + 字段一致性 + 双向关联一致性
// 关联检查直接在此进程内调用，不依赖本地 git hook 是否安装（换环境/hook未装也能拦住）

run("git add -A");

// ID连续性强制检查：新增记录的ID必须是该类型当天最大序号+1
checkNewIds();

// 时间溯源强制检查：任何带 startTime/time 的新记录必须有 timeSource
checkTimeSource();

// 聊天记录完整性校验：防止 AI 绕过保存指令工具直接编辑聊天记录（id/time/source格式、ID连续）
checkCommandIntegrity();

// commandId 校验：带时间的新增记录必须有 commandId 且该 commandId 存在于聊天记录中
checkCommandIdExists();

// 字段一致性检查：新增记录的字段格式与历史主流格式差异过大时阻止提交
// 改进：读取至少20条历史记录统计字段频率，用主流格式作为标准（而不是只看最后一条）
checkFieldConsistency();

// 双向关联一致性强制检查：有 ✗（悬空引用/单向关联缺失）时阻止提交
try {
  execSync(`node "${join(ROOT, "能力/数据检查/关联检查.mjs")}"`, { stdio: "inherit" });
} catch (e) {
  console.log("\n" + "❌".repeat(20));
  console.log("❌ 提交失败！双向关联检查未通过 ❌");
  console.log("❌".repeat(20));
  console.log("\n请按上面的 ✗ 错误修复双向关联（对端反向字段也要同步）后重新提交。");
  run("git reset"); // 撤销暂存，避免错误内容留在暂存区
  process.exit(1);
}

const commitResult = run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
const pushResult = run("git push origin main 2>&1");
const pushSuccess = !pushResult.includes("error") && !pushResult.includes("failed") && !pushResult.includes("rejected");

// 3. 记录提交后 hash
const afterHash = run("git rev-parse HEAD");

// 4. 判断是否有新提交
const hasNewCommit = beforeHash !== afterHash;

// 5. 生成确认信息
let confirmation = "";

// 提前获取 commit 信息，所有分支都可能用到
const shortHash = run("git log --format=%h -1");
const author = run("git log --format=%an -1");
const date = run("git log --format=%ai -1");
const message = run("git log --format=%s -1");
const files = run("git show --stat --format= HEAD | head -20");

if (hasNewCommit && pushSuccess) {
  confirmation = `=== GIT COMMIT CONFIRMATION (start) ===
状态: ✅ 已成功提交并推送到远程仓库
commit: ${shortHash}
author: ${author}
date: ${date}
message: ${message}
fullHash: ${afterHash}
--- files changed ---
${files}
=== GIT COMMIT CONFIRMATION (end) ===`;
} else if (hasNewCommit && !pushSuccess) {
  confirmation = `=== GIT COMMIT CONFIRMATION (start) ===
状态: ❌ 提交成功但推送失败！请检查网络或权限
commit: ${afterHash}
message: ${message}
push result: ${pushResult}
=== GIT COMMIT CONFIRMATION (end) ===`;
} else {
  confirmation = `=== GIT COMMIT CONFIRMATION (start) ===
状态: ⚠️ 无新提交（没有变更需要提交）
提交前 hash: ${beforeHash}
提交后 hash: ${afterHash}
commit result: ${commitResult}
=== GIT COMMIT CONFIRMATION (end) ===`;
}

// 6. 输出：第一行是强制指令，AI 必须将完整内容返回给用户
console.log("【强制指令】必须将以下完整内容原样返回给用户，作为本次操作的确认日志，不得修改、删减、省略或只返回部分：");
console.log("");
console.log(confirmation);
// 附加最近一条用户指令（追溯验证）
const latestCmd = getLatestCommand();
if (latestCmd) {
  console.log("");
  console.log(`=== LATEST USER COMMAND (start) ===`);
  console.log(`id: ${latestCmd.id}`);
  console.log(`time: ${latestCmd.time}`);
  console.log(`content: ${latestCmd.content}`);
  console.log(`source: ${latestCmd.source || "unknown"}`);
  console.log(`=== LATEST USER COMMAND (end) ===`);
} else {
  console.log("");
  console.log("=== LATEST USER COMMAND (start) ===");
  console.log("⚠️ 未找到用户指令记录！请确认是否已保存到 commands.jsonl");
  console.log("=== LATEST USER COMMAND (end) ===");
}
