#!/usr/bin/env node
/**
 * 保存聊天记录（唯一写入入口）
 *
 * 支持两种模式：
 *   1. command 模式：保存用户输入的原话
 *   2. reply 模式：保存AI的回复（滞后存储，下一轮开始时存上一轮的回复）
 *
 * 设计原则：
 *   - AI 只能传内容，不能传时间
 *   - 时间由程序自动获取：本地系统时间为主，远程服务器时间校验
 *   - 本地与远程偏差超过 30 秒时用远程时间，并打标记
 *   - command ID 自动生成（当天最大序号+1），AI 不能指定
 *   - reply ID 从 commandId 提取（同一轮对话序号相同），AI 不能指定
 *   - 写入后返回生成的 ID 和完整记录
 *
 * 用法：
 *   # 保存用户输入
 *   node 能力/保存指令.mjs "用户刚刚说的原话"
 *
 *   # 保存AI回复（滞后存储）
 *   node 能力/保存指令.mjs --reply "上一轮AI回复的内容" --command-id command-20260911-00001
 *
 *   # 保存AI回复（定时任务触发）
 *   node 能力/保存指令.mjs --reply "回复内容" --command-id command-20260911-00001 --source system --trigger scheduled
 *
 * 输出（JSON）：
 *   { "status": "ok", "id": "command-20260907-00002", "type": "command", "time": "...", "content": "...", "source": "chat" }
 *   { "status": "ok", "id": "reply-20260911-00001", "type": "reply", "time": "...", "content": "...", "commandId": "command-20260911-00001", "source": "chat" }
 */
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { nowTime, nowDate, TZ, offsetForAt } from "./时区.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMAND_DIR = join(ROOT, "数据", "聊天记录：我对AI说的每一句话，用于追溯");

// ============================================
// 1. 解析命令行参数
// ============================================
const args = process.argv.slice(2);

function parseArgs(args) {
  const opts = {
    isReply: false,
    commandId: null,
    source: "chat",
    trigger: null,
    content: "",
  };

  const positional = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--reply") {
      opts.isReply = true;
      i++;
    } else if (arg === "--command-id") {
      opts.commandId = args[i + 1];
      i += 2;
    } else if (arg === "--source") {
      opts.source = args[i + 1];
      i += 2;
    } else if (arg === "--trigger") {
      opts.trigger = args[i + 1];
      i += 2;
    } else {
      positional.push(arg);
      i++;
    }
  }

  opts.content = positional.join(" ").trim();
  return opts;
}

const opts = parseArgs(args);

// 校验参数
if (!opts.content) {
  console.error("错误：必须提供内容。用法：");
  console.error("  保存用户输入：node 能力/保存指令.mjs \"用户原话\"");
  console.error("  保存AI回复：node 能力/保存指令.mjs --reply \"回复内容\" --command-id command-YYYYMMDD-XXXXX");
  process.exit(1);
}

if (opts.isReply && !opts.commandId) {
  console.error("错误：reply模式必须提供 --command-id 参数");
  process.exit(1);
}

if (opts.isReply) {
  const m = opts.commandId.match(/^command-(\d{8})-(\d+)$/);
  if (!m) {
    console.error(`错误：commandId格式不正确：${opts.commandId}，应为 command-YYYYMMDD-XXXXX`);
    process.exit(1);
  }
}

// ============================================
// 2. 取本地时间
// ============================================
const localTimeStr = nowTime();
const localMs = new Date(localTimeStr).getTime();

// ============================================
// 3. 取远程服务器时间（Gitee 响应头 Date）
// ============================================
function fetchRemoteTime() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "gitee.com",
        port: 443,
        path: "/",
        method: "HEAD",
        timeout: 5000,
        headers: { "User-Agent": "Personal-Data-Repo/1.0" },
      },
      (res) => {
        const dateStr = res.headers.date;
        if (!dateStr) {
          resolve({ ok: false, reason: "no-date-header" });
          return;
        }
        const remoteMs = new Date(dateStr).getTime();
        if (Number.isNaN(remoteMs)) {
          resolve({ ok: false, reason: "invalid-date" });
          return;
        }
        resolve({ ok: true, ms: remoteMs, raw: dateStr });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, reason: "timeout" });
    });
    req.on("error", () => {
      resolve({ ok: false, reason: "network-error" });
    });
    req.end();
  });
}

const remote = await fetchRemoteTime();

// ============================================
// 4. 比对偏差，决定最终时间
// ============================================
let finalTimeStr = localTimeStr;
let timeWarning = null;

if (remote.ok) {
  const diffMs = Math.abs(localMs - remote.ms);
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec > 30) {
    const remoteDate = new Date(remote.ms);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(remoteDate);
    const get = (t) => parts.find((p) => p.type === t)?.value || "00";
    const offset = offsetForAt(remote.ms);
    finalTimeStr = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
    timeWarning = `本地时钟偏差 ${diffSec} 秒，已用 Gitee 远程时间校正（本地=${localTimeStr}，远程=${finalTimeStr}）`;
  }
} else {
  timeWarning = `远程时间获取失败（${remote.reason}），已降级使用本地时间，未经过远程校验`;
}

// ============================================
// 5. 生成 ID
// ============================================
const todayStr = nowDate().replace(/-/g, ""); // 20260907
const monthStr = nowDate().slice(0, 7); // 2026-09
const filePath = join(COMMAND_DIR, `聊天记录-${monthStr}.jsonl`);

let recordId;

if (opts.isReply) {
  // reply模式：从commandId提取日期和序号
  const m = opts.commandId.match(/^command-(\d{8})-(\d+)$/);
  const datePart = m[1];
  const seqPart = m[2];
  recordId = `reply-${datePart}-${seqPart}`;
} else {
  // command模式：当天最大序号+1
  let maxSeq = 0;
  if (existsSync(filePath)) {
    const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const m = rec.id && rec.id.match(/^command-(\d{8})-(\d+)$/);
        if (m && m[1] === todayStr) {
          const seq = parseInt(m[2], 10);
          if (seq > maxSeq) maxSeq = seq;
        }
      } catch (e) { /* ignore malformed lines */ }
    }
  }
  const nextSeq = maxSeq + 1;
  recordId = `command-${todayStr}-${String(nextSeq).padStart(5, "0")}`;
}

// ============================================
// 6. 组装记录并写入
// ============================================
const record = {
  id: recordId,
  type: opts.isReply ? "reply" : "command",
  time: finalTimeStr,
  content: opts.content,
  source: opts.source,
};

if (opts.isReply) {
  record.commandId = opts.commandId;
  record.timeSource = "system"; // reply的时间由程序自动获取系统时间
}

if (opts.trigger) {
  record.trigger = opts.trigger;
}

if (timeWarning) {
  record.timeWarning = timeWarning;
}

// 确保目录存在
if (!existsSync(COMMAND_DIR)) {
  mkdirSync(COMMAND_DIR, { recursive: true });
}

appendFileSync(filePath, JSON.stringify(record, null, 0) + "\n", "utf8");

// ============================================
// 7. 输出结果（JSON，供 AI 解析）
// ============================================
const output = {
  status: "ok",
  id: recordId,
  type: opts.isReply ? "reply" : "command",
  time: finalTimeStr,
  content: opts.content,
  source: opts.source,
  file: `聊天记录-${monthStr}.jsonl`,
};

if (opts.isReply) {
  output.commandId = opts.commandId;
}

if (opts.trigger) {
  output.trigger = opts.trigger;
}

if (timeWarning) {
  output.timeWarning = timeWarning;
}

console.log(JSON.stringify(output, null, 2));
