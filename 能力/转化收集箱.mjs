#!/usr/bin/env node
/**
 * 收集箱条目转化工具
 *
 * 将 数据/收集箱/收集箱：活跃/ 下的收集箱条目转化为具体记录类型（activity/task），
 * 自动归档到 数据/收集箱/收集箱：已转化/已转化.jsonl，删除原文件，维护双向关联。
 *
 * 用法：
 *   node 能力/转化收集箱.mjs <inbox_id> --to activity --time "..." --category "..." [--title "..."] [--note "..."] [--dry-run]
 *   node 能力/转化收集箱.mjs <inbox_id> --to task --type reminder --recurrence one_time --dueDate "..." --title "..." [--remindTime "..."] [--dry-run]
 *
 * 执行步骤：
 *   1. 查找收集箱条目，确认 status=active
 *   2. 根据目标类型创建对应记录
 *   3. 更新收集箱条目 status=converted，补 convertedTo/convertedType
 *   4. 追加到 已转化/已转化.jsonl
 *   5. 删除原 active JSON 文件
 *   6. 更新 project.inboxIds / person.inboxIds 反向关联（移除）
 *   7. 验证：转化记录存在 + converted.jsonl 有条目 + 原文件删除 + 双向关联
 *   任何一步失败自动回滚
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { nowTime } from "./时区.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "数据");
const INBOX_ACTIVE = join(DATA, "收集箱：随手记的想法灵感，暂时不需要分类的先放这里", "收集箱：活跃");
const INBOX_ARCHIVE = join(DATA, "收集箱：随手记的想法灵感，暂时不需要分类的先放这里", "收集箱：已转化", "已转化.jsonl");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}
function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}
function splitIds(s) {
  if (!s) return [];
  return String(s).split(",").map((x) => x.trim()).filter(Boolean);
}
function nextId(type, dateStr) {
  // 查找该类型当天最大序号
  const dirMap = {
    activity: join(DATA, "我的一天：一天时间轴上的所有活动，工作、运动、吃饭、睡觉"),
    intake: join(DATA, "饮食摄入：吃喝记录，饮水量和卡路里记录"),
    expense: join(DATA, "收支记录：所有花钱和收入的记录"),
  };
  const dir = dirMap[type];
  let max = 0;
  if (dir && existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
      const content = readFileSync(join(dir, f), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r.id && r.id.startsWith(`${type}-${dateStr.replace(/-/g, "")}-`)) {
            const num = parseInt(r.id.split("-").pop(), 10);
            if (num > max) max = num;
          }
        } catch {}
      }
    }
  }
  return `${type}-${dateStr.replace(/-/g, "")}-${String(max + 1).padStart(5, "0")}`;
}

// 解析参数
const args = process.argv.slice(2);
const inboxId = args.find((a) => !a.startsWith("--"));
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const targetType = getArg("to");
const dryRun = args.includes("--dry-run");

if (!inboxId || !targetType) {
  console.error("用法: node 能力/转化收集箱.mjs <inbox_id> --to <activity|task> [参数...] [--dry-run]");
  process.exit(1);
}

const supportedTypes = ["activity", "task"];
if (!supportedTypes.includes(targetType)) {
  console.error(`✗ 不支持的目标类型: ${targetType}（当前支持: ${supportedTypes.join(", ")}）`);
  process.exit(1);
}

// Step 1: 查找收集箱条目
const inboxPath = join(INBOX_ACTIVE, `${inboxId}.json`);
if (!existsSync(inboxPath)) {
  console.error(`✗ 未找到收集箱条目: ${inboxId}`);
  process.exit(1);
}
const inbox = readJson(inboxPath);
if (inbox.status !== "active") {
  console.error(`✗ 收集箱条目状态不是 active: ${inbox.status}`);
  process.exit(1);
}
console.log(`✓ 找到收集箱条目: ${inbox.content.slice(0, 40)}... (${inboxId})`);

// dry-run 模式：只预览，不执行任何写入
if (dryRun) {
  let previewTargetId = "预览ID";
  if (targetType === "activity") {
    const time = getArg("time") || nowTime();
    previewTargetId = nextId("activity", time.slice(0, 10));
  }
  console.log("\n[dry-run] 以下操作将被执行:");
  console.log(`  1. 创建 ${targetType} 记录: ${previewTargetId}`);
  console.log(`  2. 更新收集箱条目 status=converted, convertedTo=${previewTargetId}`);
  console.log(`  3. 追加到 已转化/已转化.jsonl`);
  console.log(`  4. 删除 ${inboxPath}`);
  console.log(`  5. 更新 project.inboxIds / person.inboxIds 反向关联`);
  console.log(`  6. 验证`);
  process.exit(0);
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
  let targetId = null;
  let targetRecord = null;

  // Step 2: 根据目标类型创建记录
  if (targetType === "activity") {
    const time = getArg("time") || nowTime();
    const category = getArg("category") || "日常";
    const title = getArg("title") || inbox.content.slice(0, 30);
    const note = getArg("note") || inbox.content;
    const dateStr = time.slice(0, 10);
    targetId = nextId("activity", dateStr);

    targetRecord = {
      id: targetId,
      type: "activity",
      data: {
        time,
        timeGranularity: "hour",
        activity: title,
        category,
        note: `${note}（由收集箱 ${inboxId} 转化）`,
      },
      meta: {
        source: "inbox_convert",
        importedAt: nowTime(),
        status: "written",
        convertedFromInbox: inboxId,
      },
    };
    if (inbox.projectId) targetRecord.data.projectId = inbox.projectId;
    if (inbox.peopleIds) targetRecord.data.peopleIds = inbox.peopleIds;

    // 追加到 activity.jsonl
    const activityPath = join(DATA, "我的一天：一天时间轴上的所有活动，工作、运动、吃饭、睡觉", "我的一天.jsonl");
    const activityBackup = readFileSync(activityPath, "utf-8");
    appendFileSync(activityPath, JSON.stringify(targetRecord) + "\n");
    rollbackStack.push({ desc: "恢复 activity.jsonl", func: () => writeFileSync(activityPath, activityBackup) });
    console.log(`✓ 创建 activity: ${targetId} (${title})`);
  }

  if (targetType === "task") {
    const taskType = getArg("type") || "reminder";
    const recurrence = getArg("recurrence") || "one_time";
    const dueDate = getArg("dueDate");
    const remindTime = getArg("remindTime") || "09:00";
    const title = getArg("title") || inbox.content.slice(0, 30);
    const description = getArg("description") || inbox.content;

    if (!dueDate && recurrence === "one_time") {
      throw new Error("one_time 任务必须指定 --dueDate");
    }

    targetId = `task-${Date.now()}`; // 任务ID用文件名格式，这里简化
    // 实际任务ID格式是日期前缀，这里用 dueDate 生成
    if (dueDate) {
      targetId = `${dueDate}-reminder-${inboxId.slice(-6)}`;
    }

    targetRecord = {
      id: targetId,
      type: taskType,
      title,
      description: `${description}\n\n（由收集箱 ${inboxId} 转化）`,
      recurrence,
      status: "active",
      meta: {
        createdAt: nowTime(),
        source: "inbox_convert",
        convertedFromInbox: inboxId,
      },
    };
    if (dueDate) targetRecord.dueDate = dueDate;
    if (remindTime) targetRecord.remindTime = remindTime;
    if (inbox.projectId) targetRecord.projectId = inbox.projectId;
    if (inbox.peopleIds) targetRecord.peopleIds = inbox.peopleIds;

    // 写入任务文件
    const taskPath = join(DATA, "待办任务：有到期时间或重复规则的提醒任务", `${targetId}.json`);
    writeJson(taskPath, targetRecord);
    rollbackStack.push({ desc: "删除任务文件", func: () => unlinkSync(taskPath) });
    console.log(`✓ 创建 task: ${targetId} (${title})`);
  }

  // Step 3: 更新收集箱条目
  inbox.status = "converted";
  inbox.convertedTo = targetId;
  inbox.convertedType = targetType;
  inbox.convertedAt = nowTime();
  const inboxBackup = JSON.stringify(readJson(inboxPath));
  writeJson(inboxPath, inbox);
  rollbackStack.push({ desc: "恢复收集箱条目", func: () => writeFileSync(inboxPath, inboxBackup) });
  console.log(`✓ 更新收集箱条目 status=converted, convertedTo=${targetId}`);

  // Step 4: 追加到 converted.jsonl
  if (!existsSync(dirname(INBOX_ARCHIVE))) mkdirSync(dirname(INBOX_ARCHIVE), { recursive: true });
  const archiveBackup = existsSync(INBOX_ARCHIVE) ? readFileSync(INBOX_ARCHIVE, "utf-8") : "";
  appendFileSync(INBOX_ARCHIVE, JSON.stringify(inbox) + "\n");
  rollbackStack.push({ desc: "恢复 converted.jsonl", func: () => writeFileSync(INBOX_ARCHIVE, archiveBackup) });
  console.log(`✓ 追加到 converted.jsonl`);

  // Step 5: 删除原 active 文件
  unlinkSync(inboxPath);
  rollbackStack.push({ desc: "恢复收集箱条目文件", func: () => writeJson(inboxPath, JSON.parse(inboxBackup)) });
  console.log(`✓ 删除原收集箱条目文件`);

  // Step 6: 更新反向关联
  // 6a. 从 project.inboxIds / person.inboxIds 移除原 inbox ID
  if (inbox.projectId) {
    const tpath = join(DATA, "我的项目：长期项目或者主题任务", `${inbox.projectId}.json`);
    if (existsSync(tpath)) {
      const project = readJson(tpath);
      const projectBackup = JSON.stringify(project);
      const ids = splitIds(project.inboxIds).filter((id) => id !== inboxId);
      project.inboxIds = ids.join(",");
      if (!project.inboxIds) delete project.inboxIds;
      // 6b. 目标记录的反向关联：增加 targetId
      if (targetType === "activity") {
        const aids = splitIds(project.activityIds);
        if (!aids.includes(targetId)) { aids.push(targetId); aids.sort().reverse(); project.activityIds = aids.join(","); }
      }
      if (targetType === "task") {
        const tids = splitIds(project.taskIds);
        if (!tids.includes(targetId)) { tids.push(targetId); tids.sort().reverse(); project.taskIds = tids.join(","); }
      }
      writeJson(tpath, project);
      rollbackStack.push({ desc: "恢复 project", func: () => writeFileSync(tpath, projectBackup) });
      console.log(`✓ 更新 project ${inbox.projectId}: inboxIds -${inboxId}, ${targetType}Ids +${targetId}`);
    }
  }
  for (const pid of splitIds(inbox.peopleIds)) {
    const ppath = join(DATA, "我认识的人：我认识的所有人物", `${pid}.json`);
    if (existsSync(ppath)) {
      const person = readJson(ppath);
      const personBackup = JSON.stringify(person);
      const ids = splitIds(person.inboxIds).filter((id) => id !== inboxId);
      person.inboxIds = ids.join(",");
      if (!person.inboxIds) delete person.inboxIds;
      // 目标记录的反向关联：增加 targetId
      if (targetType === "activity") {
        const aids = splitIds(person.activityIds);
        if (!aids.includes(targetId)) { aids.push(targetId); aids.sort().reverse(); person.activityIds = aids.join(","); }
      }
      if (targetType === "task") {
        const tids = splitIds(person.taskIds);
        if (!tids.includes(targetId)) { tids.push(targetId); tids.sort().reverse(); person.taskIds = tids.join(","); }
      }
      writeJson(ppath, person);
      rollbackStack.push({ desc: `恢复 person ${pid}`, func: () => writeFileSync(ppath, personBackup) });
      console.log(`✓ 更新 person ${pid}: inboxIds -${inboxId}, ${targetType}Ids +${targetId}`);
    }
  }

  // Step 7: 验证
  console.log("\n=== 验证 ===");
  let valid = true;

  // 验证目标记录存在
  if (targetType === "activity") {
    const activityPath = join(DATA, "我的一天：一天时间轴上的所有活动，工作、运动、吃饭、睡觉", "我的一天.jsonl");
    const found = readFileSync(activityPath, "utf-8").split("\n").some((l) => l.includes(`"id":"${targetId}"`) || l.includes(`"id": "${targetId}"`));
    if (found) console.log(`✓ activity 记录存在: ${targetId}`);
    else { console.log(`✗ activity 记录不存在: ${targetId}`); valid = false; }
  }
  if (targetType === "task") {
    const taskPath = join(DATA, "待办任务：有到期时间或重复规则的提醒任务", `${targetId}.json`);
    if (existsSync(taskPath)) console.log(`✓ task 文件存在: ${targetId}`);
    else { console.log(`✗ task 文件不存在: ${targetId}`); valid = false; }
  }

  // 验证 converted.jsonl 有条目
  const archiveContent = existsSync(INBOX_ARCHIVE) ? readFileSync(INBOX_ARCHIVE, "utf-8") : "";
  if (archiveContent.includes(inboxId)) console.log(`✓ converted.jsonl 中有条目: ${inboxId}`);
  else { console.log(`✗ converted.jsonl 中无条目: ${inboxId}`); valid = false; }

  // 验证原文件删除
  if (!existsSync(inboxPath)) console.log(`✓ 原收集箱文件已删除`);
  else { console.log(`✗ 原收集箱文件仍存在`); valid = false; }

  // 验证双向关联
  try {
    execSync("node 能力/数据检查/关联检查.mjs", { cwd: ROOT, stdio: "pipe" });
    console.log(`✓ 双向关联一致`);
  } catch (e) {
    console.log(`✗ 双向关联检查失败`);
    valid = false;
  }

  if (!valid) {
    throw new Error("验证未通过");
  }

  console.log(`\n✅ 转化完成！`);
  console.log(`  收集箱: ${inboxId}`);
  console.log(`  转化为: ${targetType} (${targetId})`);
  console.log(`  已归档到 converted.jsonl，原文件已删除`);
} catch (e) {
  console.error(`\n✗ 转化失败: ${e.message}`);
  rollback();
  process.exit(1);
}

console.log("\n⚠️ 提交铁律：所有 git 提交必须通过 `node 能力/提交并确认.mjs \"提交信息\"` 执行，禁止直接 git add/commit/push。");
