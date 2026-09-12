#!/usr/bin/env node
/**
 * 任务归档工具（一键执行，自动验证，失败回滚）
 * 用法:
 *   node 能力/归档任务.mjs <task_id> [--time "YYYY-MM-DDTHH:mm:ss+08:00"] [--category "日常"] [--note "备注"] [--dry-run]
 *
 * 执行步骤：
 *   1. 查找任务，确认是 one_time 类型且 status=active
 *   2. 创建 activity 完成记录（带 archivedFromTask）
 *   3. 更新任务 status=completed，补 completedAt/completedActivityId/completedBy
 *   4. 追加到 已归档/已完成.jsonl
 *   5. 删除原任务文件
 *   6. 更新 person.activityIds / project.activityIds 反向关联
 *   7. 验证：归档4点检查 + 双向关联一致性
 *   任何一步失败自动回滚所有改动
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nowTime } from "./时区.mjs";

function loadTypes() {
  const types = {};
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
          if (td && td.key) types[td.key] = td;
        } catch(e) {}
      }
    }
  }
  return types;
}

import { execSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "数据");

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function writeJsonl(path, records) {
  writeFileSync(path, records.map((r) => JSON.stringify(r, null, 0)).join("\n") + "\n", "utf8");
}
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function splitIds(s) {
  if (!s) return [];
  return String(s).split(",").map((x) => x.trim()).filter(Boolean);
}
function nextId(type, dateStr) {
  // 生成新 ID：<type>-<YYYYMMDD>-<5位序号>
  // 从实际存储路径读取已有记录，避免重复ID
  const typeDefs = loadTypes();
  const storage = typeDefs[type]?.storage || join(DATA, type, `${type}.jsonl`);
  const filepath = storage.endsWith(".jsonl") ? join(ROOT, storage) : join(ROOT, storage, `${type}.jsonl`);
  const records = readJsonl(filepath);
  const prefix = `${type}-${dateStr.replace(/-/g, "")}-`;
  const nums = records.filter((r) => r.id.startsWith(prefix)).map((r) => parseInt(r.id.slice(prefix.length), 10));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}${String(next).padStart(5, "0")}`;
}

// 解析参数
const args = process.argv.slice(2);
let taskId = args.find((a) => !a.startsWith("--"));
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const searchKeyword = getArg("search");
const completeTime = getArg("time") || nowTime();
const category = getArg("category") || "日常";
const note = getArg("note") || "";
const dryRun = args.includes("--dry-run");

// --search 模式：按关键词搜索匹配任务
if (searchKeyword) {
  const keyword = searchKeyword.toLowerCase();
  const matched = [];
  for (const f of readdirSync(join(DATA, "待办任务：有到期时间或重复规则的提醒任务")).filter((f) => f.endsWith(".json"))) {
    const t = readJson(join(DATA, "待办任务：有到期时间或重复规则的提醒任务", f));
    if (t.status !== "active") continue;
    if (t.recurrence !== "one_time" && t.recurrence !== "daily") continue;
    const text = (t.title + " " + (t.description || "")).toLowerCase();
    if (text.includes(keyword)) {
      matched.push(t);
    }
  }
  if (matched.length === 0) {
    console.log(`未找到匹配"${searchKeyword}"的活跃 one_time/daily 任务。`);
    console.log("将直接创建 activity 记录（不归档任务）。");
    process.exit(2); // 退出码2表示未匹配，调用方应直接录入activity
  }
  if (matched.length > 1) {
    console.log(`匹配到 ${matched.length} 个任务，请明确指定 task_id：`);
    matched.forEach((t, i) => console.log(`  ${i + 1}. ${t.id} — ${t.title} (due: ${t.dueDate || "daily"})`));
    process.exit(3); // 退出码3表示多匹配，需用户选择
  }
  taskId = matched[0].id;
  console.log(`✓ 匹配到任务: ${matched[0].title} (${taskId})`);
}

if (!taskId) {
  console.error("用法:");
  console.error("  node 能力/归档任务.mjs <task_id> [--time ...] [--category ...] [--note ...] [--dry-run]");
  console.error("  node 能力/归档任务.mjs --search <关键词> [--time ...] [--category ...] [--note ...] [--dry-run]");
  process.exit(1);
}

// 回滚栈
const rollbackStack = [];
function rollback() {
  console.log("\n⚠ 检测到失败，开始回滚...");
  while (rollbackStack.length) {
    const action = rollbackStack.pop();
    try {
      action.func();
      console.log(`  ↩ 回滚: ${action.desc}`);
    } catch (e) {
      console.error(`  ✗ 回滚失败: ${action.desc} - ${e.message}`);
    }
  }
}

try {
  // Step 1: 查找任务
  const taskPath = join(DATA, "待办任务：有到期时间或重复规则的提醒任务", `${taskId}.json`);
  if (!existsSync(taskPath)) {
    console.error(`✗ 任务不存在: ${taskPath}`);
    process.exit(1);
  }
  const task = readJson(taskPath);
  if (task.status !== "active") {
    console.error(`✗ 任务状态不是 active: ${task.status}`);
    process.exit(1);
  }
  if (task.recurrence !== "one_time" && task.recurrence !== "daily") {
    console.error(`✗ 只有 one_time/daily 类型可以归档，当前: ${task.recurrence}`);
    process.exit(1);
  }
  console.log(`✓ 找到任务: ${task.title} (${taskId})`);

  if (dryRun) {
    console.log("\n[dry-run] 以下操作将被执行:");
    console.log(`  1. 创建 activity 记录: ${task.title}, time=${completeTime}, category=${category}`);
    console.log(`  2. 更新任务 status=completed, completedActivityId=<新ID>`);
    console.log(`  3. 追加到 已归档/已完成.jsonl`);
    console.log(`  4. 删除 ${taskPath}`);
    console.log(`  5. 更新 person.activityIds / project.activityIds 反向关联`);
    console.log(`  6. 验证归档4点 + 双向关联`);
    process.exit(0);
  }

  // Step 2: 创建 activity 记录
  const dateStr = completeTime.slice(0, 10);
  const activityId = nextId("activity", dateStr);
  const activityRecord = {
    id: activityId,
    type: "activity",
    data: {
      startTime: completeTime,
      endTime: completeTime,
      timeGranularity: "hour",
      activity: task.title,
      category: category,
      note: note ? `${note}（任务完成归档，原任务ID: ${taskId}）` : `任务完成归档，原任务ID: ${taskId}`,
      archivedFromTask: taskId,
    },
    meta: {
      source: "task_archive",
      importedAt: nowTime(),
      status: "written",
    },
  };
  // 继承 peopleIds 和 projectId
  if (task.peopleIds) activityRecord.data.peopleIds = task.peopleIds;
  if (task.projectId) activityRecord.data.projectId = task.projectId;
  // 继承 location（如果有）
  if (task.location) activityRecord.data.location = task.location;

  const activityPath = join(DATA, "我的一天：一天时间轴上的所有活动，工作、运动、吃饭、睡觉/我的一天.jsonl");
  const activities = readJsonl(activityPath);
  const activitiesBackup = JSON.stringify(activities);
  activities.push(activityRecord);
  // 按 startTime 倒序
  activities.sort((a, b) => String(b.data?.startTime || b.data?.time || "").localeCompare(String(a.data?.startTime || a.data?.time || "")));
  writeJsonl(activityPath, activities);
  rollbackStack.push({ desc: "恢复 activity.jsonl", func: () => writeFileSync(activityPath, activitiesBackup) });
  console.log(`✓ 创建 activity: ${activityId} (${task.title})`);

  // Step 3: 更新任务 status
  task.status = "completed";
  task.meta = task.meta || {};
  task.meta.completedAt = completeTime;
  task.meta.completedActivityId = activityId;
  task.meta.completedBy = "user";
  task.meta.updatedAt = nowTime();
  console.log(`✓ 更新任务 status=completed, completedActivityId=${activityId}`);

  // Step 4: 追加到 completed.jsonl
  const archivePath = join(DATA, "待办任务：有到期时间或重复规则的提醒任务/待办任务：已归档/已完成.jsonl");
  if (!existsSync(dirname(archivePath))) mkdirSync(dirname(archivePath), { recursive: true });
  appendFileSync(archivePath, JSON.stringify(task) + "\n", "utf8");
  rollbackStack.push({
    desc: "从 completed.jsonl 移除刚追加的任务",
    func: () => {
      const lines = readFileSync(archivePath, "utf8").split("\n").filter((l) => l.trim());
      const filtered = lines.filter((l) => !l.includes(`"id":"${taskId}"`));
      writeFileSync(archivePath, filtered.join("\n") + (filtered.length ? "\n" : ""));
    },
  });
  console.log(`✓ 追加到 completed.jsonl`);

  // Step 5: 删除原任务文件
  const taskBackup = JSON.stringify(task);
  unlinkSync(taskPath);
  rollbackStack.push({ desc: "恢复任务文件", func: () => writeFileSync(taskPath, taskBackup) });
  console.log(`✓ 删除原任务文件`);

  // Step 6: 更新反向关联（person.activityIds/taskIds + project.activityIds/taskIds）
  // person
  const personIds = splitIds(task.peopleIds);
  for (const pid of personIds) {
    const ppath = join(DATA, "我认识的人：我认识的所有人物", `${pid}.json`);
    if (!existsSync(ppath)) continue;
    const person = readJson(ppath);
    const personBackup = JSON.stringify(person);
    // activityIds
    const aids = splitIds(person.activityIds);
    if (!aids.includes(activityId)) {
      aids.push(activityId);
      aids.sort().reverse();
      person.activityIds = aids.join(",");
    }
    // taskIds（归档任务也保留反向关联）
    const tids = splitIds(person.taskIds);
    if (!tids.includes(taskId)) {
      tids.push(taskId);
      tids.sort().reverse();
      person.taskIds = tids.join(",");
    }
    writeJson(ppath, person);
    rollbackStack.push({ desc: `恢复 person ${pid}`, func: () => writeFileSync(ppath, personBackup) });
    console.log(`✓ 更新 person ${pid} (${person.name}): activityIds +${activityId}, taskIds +${taskId}`);
  }
  // project
  if (task.projectId) {
    const tpath = join(DATA, "我的项目：长期项目或者主题任务", `${task.projectId}.json`);
    if (existsSync(tpath)) {
      const project = readJson(tpath);
      const projectBackup = JSON.stringify(project);
      // activityIds
      const aids = splitIds(project.activityIds);
      if (!aids.includes(activityId)) {
        aids.push(activityId);
        aids.sort().reverse();
        project.activityIds = aids.join(",");
      }
      // taskIds（归档任务也保留反向关联）
      const tids = splitIds(project.taskIds);
      if (!tids.includes(taskId)) {
        tids.push(taskId);
        tids.sort().reverse();
        project.taskIds = tids.join(",");
      }
      writeJson(tpath, project);
      rollbackStack.push({ desc: `恢复 project ${task.projectId}`, func: () => writeFileSync(tpath, projectBackup) });
      console.log(`✓ 更新 project ${task.projectId} (${project.name}): activityIds +${activityId}, taskIds +${taskId}`);
    }
  }

  // Step 7: 验证
  console.log("\n=== 验证 ===");
  let pass = true;

  // 7a: activity 中有对应记录
  const verifyActivities = readJsonl(activityPath);
  if (!verifyActivities.find((a) => a.id === activityId)) {
    console.error(`✗ 验证失败: activity ${activityId} 不存在`);
    pass = false;
  } else console.log(`✓ activity 记录存在: ${activityId}`);

  // 7b: completed.jsonl 中有该任务
  const archived = readJsonl(archivePath);
  if (!archived.find((t) => t.id === taskId)) {
    console.error(`✗ 验证失败: completed.jsonl 中没有 ${taskId}`);
    pass = false;
  } else console.log(`✓ completed.jsonl 中有任务: ${taskId}`);

  // 7c: 原文件已删除
  if (existsSync(taskPath)) {
    console.error(`✗ 验证失败: 原任务文件仍存在`);
    pass = false;
  } else console.log(`✓ 原任务文件已删除`);

  // 7d: 双向关联检查
  try {
    execSync(`node "${join(ROOT, "能力/数据检查/关联检查.mjs")}"`, { stdio: "pipe" });
    console.log(`✓ 双向关联一致`);
  } catch (e) {
    console.error(`✗ 双向关联检查失败:`);
    const output = e.stdout ? e.stdout.toString() : "";
    output.split("\n").filter((l) => l.includes("✗")).forEach((l) => console.error(`  ${l}`));
    pass = false;
  }

  if (!pass) {
    throw new Error("验证未通过");
  }

  console.log("\n✅ 归档完成！");
  console.log(`  任务: ${task.title} (${taskId})`);
  console.log(`  完成时间: ${completeTime}`);
  console.log(`  activity: ${activityId}`);
  console.log(`  已追加到 completed.jsonl，原文件已删除`);
} catch (e) {
  console.error(`\n✗ 归档失败: ${e.message}`);
  rollback();
  process.exit(1);
}

console.log("\n⚠️ 提交铁律：所有 git 提交必须通过 `node 能力/提交并确认.mjs \"提交信息\"` 执行，禁止直接 git add/commit/push。");
