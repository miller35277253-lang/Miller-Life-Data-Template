#!/usr/bin/env node
/**
 * 今日总览渲染器 —— 只读数据端口，按 可视化规范.md 渲染今日卡片
 * 用法: node 能力/渲染今日.mjs [--date YYYY-MM-DD] [--mode morning|evening|full] [--out <path>]
 * 原则: 不修改任何数据；板块无数据则隐藏。
 *
 * 布局约定（简洁聚合版）：
 *   1. 财务卡：今日支出大数字 + 「今日 X/Y」「本月 X/Y」同行对比 + 分类明细紧跟总金额下
 *   2. 健康卡：饮水 / 摄入热量 / 步数 / 体重 / 睡眠 聚合在一张卡
 *   3. 安排卡：明日(报)或今日(早报)安排，有事项才显示，无则不显示
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dueOn, dueLabel } from "./调度.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "数据");
const RECORDS = DATA;
const TASKS = join(DATA, "待办任务：有到期时间或重复规则的提醒任务");
const OUTDIR = join(ROOT, "reports");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/* ---- 参数 ---- */
const args = process.argv.slice(2);
const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dateArg = getArg("--date");
const mode = getArg("--mode") || "full";
let outArg = getArg("--out");

const tzNow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const fmtYMD = (d) => tzNow.format(d).split("/").join("-");
const today = dateArg || fmtYMD(new Date());
const todayDate = new Date(today + "T00:00:00+08:00");

/* ---- 数据加载 ---- */
function loadTypes() {
  // 扫描 数据/ 和根目录下的所有文件夹，找 "*：类型配置.json" 文件
  const types = {};
  const scanDirs = [DATA, ROOT];
  for (const baseDir of scanDirs) {
    if (!existsSync(baseDir)) continue;
    for (const dirName of readdirSync(baseDir)) {
      const dirPath = join(baseDir, dirName);
      if (!statSync(dirPath).isDirectory()) continue;
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
const types = loadTypes();
function loadType(type) {
  const out = [];
  const readJsonl = (filePath, label) => {
    if (!existsSync(filePath)) return;
    readFileSync(filePath, "utf8").split("\n").forEach((l, i) => {
      if (!l.trim()) return;
      try { out.push(JSON.parse(l)); }
      catch (e) { console.error(`警告: ${label}:${i + 1} JSON 解析失败，已跳过`); }
    });
  };

  // 优先使用类型配置中的 storage 字段（支持完整路径/目录/纯文件名三种格式）
  const typedef = types[type];
  if (typedef && typedef.storage) {
    const storage = typedef.storage;
    let target = null;
    if (storage.startsWith("数据/")) {
      target = join(ROOT, storage);
    } else {
      // 纯文件名（如 "会员卡与套餐.jsonl"）：在 数据/ 各子目录中查找
      for (const dirName of readdirSync(DATA)) {
        const candidate = join(DATA, dirName, storage);
        if (existsSync(candidate)) { target = candidate; break; }
      }
    }
    if (target && existsSync(target)) {
      if (statSync(target).isDirectory()) {
        for (const f of readdirSync(target).filter(f => f.endsWith(".jsonl"))) {
          readJsonl(join(target, f), `${type}/${f}`);
        }
      } else {
        readJsonl(target, storage);
      }
    }
    return out;
  }

  // 回退：按英文类型名找目录（兼容旧行为）
  const dir = join(RECORDS, type);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter(f => f.endsWith(".jsonl"))) {
      readJsonl(join(dir, f), `${type}/${f}`);
    }
  }
  return out;
}
function loadTasks() {
  if (!existsSync(TASKS)) return [];
  const out = [];
  for (const f of readdirSync(TASKS).filter((f) => f.endsWith(".json"))) {
    try { out.push(readJson(join(TASKS, f))); }
    catch (e) { console.error(`警告: tasks/${f} 解析失败，已跳过`); }
  }
  return out;
}
const dateOf = (r) => ((r.data.startTime || r.data.time || r.data.date) || "").slice(0, 10);
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const weekday = weekdays[todayDate.getDay()];
const monthStr = today.slice(0, 7); // YYYY-MM

/* ---- 按 mode 确定取数日期 ---- */
const isMorning = mode === "morning";
const isEvening = mode === "evening";
const yesterday = new Date(todayDate.getTime() - 86400000);
const yesterdayStr = fmtYMD(yesterday);
const dataDate = isMorning ? yesterdayStr : today; // 早报看昨天，晚报看今天
const tomorrowDate = new Date(todayDate.getTime() + 86400000);
const tomorrowStr = fmtYMD(tomorrowDate);
const scheduleDate = isMorning ? today : tomorrowStr; // 早报看今日安排，晚报看明日安排

/* ---- 数据取数 ---- */
const expenses = loadType("expense").filter((r) => dateOf(r) === dataDate);
const monthExpenses = loadType("expense").filter((r) => dateOf(r).startsWith(monthStr));
const activityAll = loadType("activity");
const weightAll = loadType("weight");
const exerciseAll = loadType("exercise");
const intakeAll = loadType("intake");
const stepsAll = loadType("steps");
const tasks = loadTasks();

// 健康参考线值（config/健康目标.json -> 各目标的 value）
let healthTargets = {};
try { healthTargets = readJson(join(DATA, "配置：我的预算、目标等用来聚合的数据", "健康目标.json")).targets || {}; } catch (e) { /* 无则跳过 */ }

// 预算配置（config/预算_YYYY-MM.json）
let budgetCfg = null;
try {
  const bf = join(DATA, "配置：我的预算、目标等用来聚合的数据", `预算_${monthStr}.json`);
  if (existsSync(bf)) budgetCfg = readJson(bf);
} catch (e) { /* 无则跳过 */ }

// 睡眠：从 activity 中取 category 含「睡眠」的时间块；晚报看今晚，早报看前夜
const sleepPrev = new Date(scheduleDate === today ? yesterdayStr : dataDate);
const sleepPrevStr = fmtYMD(sleepPrev);
const sleepBlocks = activityAll.filter((r) => String(r.data.category || "").includes("睡眠"));
const lastNight = sleepBlocks.filter((r) => dateOf(r) === sleepPrevStr).sort((a, b) => (b.data.startTime || "").localeCompare(a.data.startTime || ""))[0]
  || sleepBlocks.filter((r) => dateOf(r) === dataDate).sort((a, b) => (b.data.startTime || "").localeCompare(a.data.startTime || ""))[0];

const dataWeight = weightAll.filter((r) => dateOf(r) === dataDate).sort((a, b) => (b.data.time || "").localeCompare(a.data.time || ""))[0];
const recentWeight = weightAll.slice().sort((a, b) => (b.data.time || "").localeCompare(a.data.time || ""))[0];
const weightShown = dataWeight || recentWeight;

const dataExercise = exerciseAll.filter((r) => dateOf(r) === dataDate);
const activeTasks = tasks.filter((t) => t.status === "active");
const dueScheduleShown = activeTasks.filter((t) => dueOn(t, scheduleDate));
// 无时间任务（事件触发）：status=active 且 无 dueDate 且 triggerType=event
const eventTasks = activeTasks.filter((t) => !t.dueDate && t.triggerType === "event");

// 当日摄入：饮水 = intakeType=drink 且单位 ml 的总和；热量 = 全部 calories 之和
const dayIntake = intakeAll.filter((r) => dateOf(r) === dataDate);
const waterML = dayIntake
  .filter((r) => r.data.intakeType === "drink" && r.data.unit === "ml")
  .reduce((s, r) => s + (r.data.amount || 0), 0);
const calSum = dayIntake.reduce((s, r) => s + (r.data.calories || 0), 0);
const stepsDay = stepsAll.filter((r) => dateOf(r) === dataDate).reduce((s, r) => s + (r.data.steps || r.data.value || 0), 0);

const yuan = (n) => "¥" + Number(n).toLocaleString("zh-CN", { minimumFractionDigits: 2 });
const num = (n) => Number(n).toFixed(2);
const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---- 分类色板 ---- */
const CAT_COLORS = ["#5B6CFF", "#2FB26B", "#F59E0B", "#EF4444", "#0EA5E9", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316", "#64748B", "#84CC16"];
const catPalette = {};
let ci = 0;
const colorFor = (cat) => { if (!(cat in catPalette)) { catPalette[cat] = CAT_COLORS[ci++ % CAT_COLORS.length]; } return catPalette[cat]; };

const sections = [];

// 计算来到世界第N天
let dayOfLife = "";
try {
  const profile = JSON.parse(readFileSync(join(ROOT, "个人档案.json"), "utf8"));
  if (profile.birthday) {
    const birth = new Date(profile.birthday + "T00:00:00+08:00");
    const now = new Date(today + "T00:00:00+08:00");
    const days = Math.floor((now - birth) / (1000 * 60 * 60 * 24));
    dayOfLife = `来到世界第 ${days} 天`;
  }
} catch(e) {}

/* ============ 头部 ============ */
sections.push({ title: "头部", html: `
  <div class="card head">
    <div class="hd-top">
      <div class="hdate">${today.slice(5).replace("-", "月")}日 · ${weekday}</div>
      <div class="hmode">${mode === "morning" ? "早安 · 今日安排" : mode === "evening" ? "晚安 · 今日收账" : "今日记录"}</div>
    </div>
    <div class="hlarge">${monthStr.replace("-", "年")}月</div>
    ${dayOfLife ? `<div class="hsub">${dayOfLife}</div>` : ""}
  </div>` });

/* ============ 昨日汇总（仅早报模式） ============ */
if (isMorning) {
  const yStr = yesterdayStr; // 复用上方已按上海时区正确计算的昨天日期，避免 toISOString 时区偏移
  const allExpenses = loadType("expense");
  const yExpenses = allExpenses.filter(r => dateOf(r) === yStr);
  const ySteps = stepsAll.filter(r => dateOf(r) === yStr);
  const yIntakes = intakeAll.filter(r => dateOf(r) === yStr);
  const yCalories = yIntakes.reduce((s, r) => s + (r.data.calories || 0), 0);
  const yTotal = yExpenses.reduce((s, r) => s + (r.data.amount || 0), 0);
  const yStepVal = ySteps.length ? (ySteps[0].data.steps || ySteps[0].data.value || ySteps[0].value) : 0;
  
  if (yExpenses.length || ySteps.length || yIntakes.length) {
    const rows = [];
    if (yExpenses.length) rows.push(`<div class="row"><span>支出</span><span class="num">¥${yTotal.toFixed(2)}</span></div>`);
    if (ySteps.length) rows.push(`<div class="row"><span>步数</span><span class="num">${yStepVal}步</span></div>`);
    if (yIntakes.length) rows.push(`<div class="row"><span>摄入热量</span><span class="num">${yCalories}大卡</span></div>`);
    sections.push({ title: "昨日汇总", html: `<div class="card"><div class="ctitle">昨日汇总 · ${yStr.slice(5).replace("-", "月")}日</div>${rows.join("")}</div>` });
  }
}

/* ============ 财务卡 ============ */
if (expenses.length) {
  const total = expenses.reduce((s, r) => s + (r.data.amount || 0), 0);
  const daily = budgetCfg ? budgetCfg.dailyLimit || 100 : null;
  const mcap = budgetCfg ? budgetCfg.monthlyCap : null;
  const mtotal = monthExpenses.reduce((s, r) => s + (r.data.amount || 0), 0);
  const dayLabel = isMorning ? "昨日" : "今日";

  // 今日预算对比（同一行）：¥212.10 / ¥100
  let dayLine = "";
  if (daily != null) {
    const dOver = total > daily;
    dayLine = `<div class="budget-line"><span>${dayLabel} ${yuan(total)} / ${yuan(daily)}</span><span class="bud ${dOver ? "over" : "ok"}">${dOver ? "超支" + (total - daily > 0 ? " ¥" + num(total - daily) : "") : "余 ¥" + num(daily - total)}</span></div>`;
  }

  // 本月对比（同一行右侧 / 换一行）
  let monthLine = "";
  if (mcap != null && isEvening) {
    const mOver = mtotal > mcap;
    monthLine = `<div class="budget-line"><span>本月 ${mtotal ? yuan(mtotal) : "¥0"} / ${yuan(mcap)}</span><span class="bud ${mOver ? "over" : "ok"}">${mOver ? "已超 ¥" + num(mtotal - mcap) : "余 ¥" + num(mcap - mtotal)}</span></div>`;
  }

  // 分类明细（紧跟主数字）
  const byCat = {};
  for (const r of expenses) {
    const k = r.data.categoryL2 || r.data.categoryL1 || "其他";
    byCat[k] = byCat[k] || { total: 0, n: 0, l1: r.data.categoryL1 || "" };
    byCat[k].total += r.data.amount || 0;
    byCat[k].n++;
  }
  const rows = Object.entries(byCat).sort((a, b) => b[1].total - a[1].total).map(([k, v]) => `
    <div class="row">
      <span class="dot" style="background:${colorFor(v.l1 || k)}"></span>
      <span class="rname">${escapeHtml(k)}${v.l1 ? `<span class="rl1">${escapeHtml(v.l1)}</span>` : ""}</span>
      <span class="rcount">${v.n}笔</span>
      <span class="ramt">${yuan(v.total)}</span>
    </div>`).join("");

  sections.push({ title: "财务", html: `
    <div class="card">
      <div class="ctitle">${isMorning ? "昨日支出" : "今日支出"}</div>
      <div class="big">${yuan(total)}</div>
      ${dayLine}
      ${monthLine}
      <div class="divider"></div>
      ${rows}
    </div>` });
}

/* ============ 2. 健康卡（饮水/热量/步数/体重/睡眠 聚合） ============ */
{
  const wT = healthTargets.water || {}; const cT = healthTargets.calories || {}; const sT = healthTargets.steps || {};
  const blocks = [];
  const prog = (label, a, b) => {
    if (a == null) return "";
    const unit = ({ "饮水": "ml", "摄入热量": "kcal", "步数": "步" })[label] || "";
    const pct = b ? Math.min(100, Math.round(a / b * 100)) : 0;
    const ok = b ? a >= b : a > 0;
    return `<div class="h-block"><div class="h-top"><span>${label}</span><b>${a}${unit}${b ? ` / ${b}${unit}` : ""}</b></div><div class="bar"><i style="width:${pct}%;background:${b? (ok?"#2FB26B":"#F59E0B") : "#D1D5DB"}"></i></div></div>`;
  };
  if (waterML > 0) blocks.push(prog("饮水", waterML, wT.value));
  if (calSum > 0) blocks.push(prog("摄入热量", calSum, cT.value));
  if (stepsDay > 0) blocks.push(prog("步数", stepsDay, sT.value));
  if (weightShown) blocks.push(`<div class="h-stat"><span>体重</span><b>${weightShown.data.value} ${types.weight.unit || "kg"}</b></div>`);
  if (lastNight) {
    const start = new Date(lastNight.data.startTime);
    const end = lastNight.data.endTime ? new Date(lastNight.data.endTime) : null;
    const hrs = end && end > start ? ((end - start) / 3600000).toFixed(1) : null;
    blocks.push(`<div class="h-stat"><span>睡眠</span><b>${hrs ? hrs + " h" : escapeHtml(lastNight.data.note || "已记录")}</b></div>`);
  }

  if (blocks.length) {
    sections.push({ title: "健康", html: `
      <div class="card">
        <div class="ctitle">${isMorning ? "昨日健康" : "今日健康"}</div>
        <div class="h-grid">${blocks.join("")}</div>
      </div>` });
  }
}

/* ============ 3. 安排卡（早报=今日，晚报=明日；无则隐藏） ============ */
if (isMorning || dueScheduleShown.length) {
  const label = isMorning ? "今日安排" : "明日安排";
  const rows = dueScheduleShown.length
    ? dueScheduleShown.map((t) => `
      <div class="row">
        <span class="dot" style="background:#EF4444"></span>
        <span class="rname">${escapeHtml(t.title)}</span>
        <span class="rcount">${dueLabel(t, scheduleDate)}</span>
      </div>`).join("")
    : `<div class="row"><span class="rname">今日暂无安排</span></div>`;
  sections.push({ title: "安排", html: `<div class="card"><div class="ctitle">${label}</div>${rows}</div>` });
}

/* ============ 3.5 待触发任务（无固定时间，事件触发） ============ */
if (eventTasks.length > 0) {
  const eventRows = eventTasks.map((t) => `
    <div class="row">
      <span class="dot" style="background:#F59E0B"></span>
      <span class="rname">${escapeHtml(t.title)}</span>
      <span class="rcount">${escapeHtml(t.triggerCondition || "条件触发")}</span>
    </div>`).join("");
  sections.push({ title: "待触发", html: `<div class="card"><div class="ctitle">待触发任务 · ${eventTasks.length}条</div>${eventRows}</div>` });
}

/* ============ 4. 收集箱（活跃条目，无则隐藏） ============ */
const INBOX_ACTIVE = join(DATA, "收集箱：随手记的想法灵感，暂时不需要分类的先放这里", "收集箱：活跃");
let inboxItems = [];
if (existsSync(INBOX_ACTIVE)) {
  inboxItems = readdirSync(INBOX_ACTIVE)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(INBOX_ACTIVE, f), "utf8")))
    .filter((i) => i.status === "active")
    .sort((a, b) => new Date(b.time) - new Date(a.time));
}
if (inboxItems.length > 0) {
  const inboxRows = inboxItems.map((i) => `
    <div class="row">
      <span class="dot" style="background:#8B5CF6"></span>
      <span class="rname">${escapeHtml(i.content.slice(0, 40))}${i.content.length > 40 ? "..." : ""}</span>
      <span class="rcount">${i.time ? i.time.slice(5, 10) : ""}</span>
    </div>`).join("");
  sections.push({ title: "收集箱", html: `<div class="card"><div class="ctitle">收集箱 · ${inboxItems.length}条待处理</div>${inboxRows}</div>` });
}

/* ---- 组装 HTML ---- */
const body = sections.map((s) => s.html).join("\n") || `<div class="card empty">今日暂无记录</div>`;
const html = `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>今日总览 · ${today}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-font-smoothing:antialiased}
body{background:#F2F3F7;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;color:#111827;padding:20px 14px 40px;max-width:440px;margin:0 auto}
.card{background:#fff;border-radius:20px;box-shadow:0 4px 14px rgba(15,23,42,.06);padding:18px;margin-bottom:14px}
.head{background:linear-gradient(180deg,#ffffff,#f7f8fb)}
.hd-top{display:flex;justify-content:space-between;align-items:baseline}
.hdate{font-size:22px;font-weight:700;letter-spacing:.3px}
.hmode{font-size:12px;color:#9CA3AF}
.hlarge{margin-top:2px;font-size:13px;color:#9CA3AF}
.ctitle{font-size:12px;color:#9CA3AF;font-weight:600;letter-spacing:.6px;text-transform:uppercase}
.big{font-size:36px;font-weight:800;margin:6px 0 8px}
.flex-line{display:flex;justify-content:space-between;align-items:center;font-size:14px;color:#374151;padding:3px 0}
.budget-line{display:flex;justify-content:space-between;align-items:center;font-size:14px;color:#374151;padding:3px 0}
.bud{font-size:12px;font-weight:600;border-radius:9px;padding:2px 8px}
.bud.over{color:#EF4444;background:#FDECEC}
.bud.ok{color:#2FB26B;background:#EAF7F0}
.divider{height:1px;background:#F1F2F5;margin:10px 0 2px}
.row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #F4F5F7}
.row:last-child{border-bottom:none}
.dot{width:9px;height:9px;border-radius:50%;flex:none}
.rname{flex:1;font-size:15px;font-weight:500}
.rl1{font-size:11px;color:#B0B4BC;margin-left:6px}
.rcount{font-size:12px;color:#9CA3AF}
.ramt{font-size:15px;font-weight:700;color:#111827}
.h-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;margin-top:10px}
.h-block{border-bottom:1px dashed #F1F2F5;padding-bottom:8px}
.h-top{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;color:#6B7280;margin-bottom:5px}
.h-top b{color:#111827;font-size:14px}
.h-stat{display:flex;flex-direction:column;border-bottom:1px dashed #F1F2F5;padding-bottom:8px}
.h-stat span{font-size:13px;color:#6B7280}
.h-stat b{font-size:22px;font-weight:800;color:#111827}
.bar{height:6px;border-radius:4px;background:#EEF0F4;overflow:hidden}
.bar i{display:block;height:100%;border-radius:4px;transition:width .3s}
.empty{color:#9CA3AF;text-align:center;padding:30px;font-size:14px}
</style></head><body>${body}
<footer style="text-align:center;font-size:11px;color:#C3C6CD;margin-top:6px">今日总览 · ${today}</footer>
</body></html>`;

/* ---- 输出 ---- */
if (outArg === "stdout") {
  console.log(body);
} else {
  mkdirSync(OUTDIR, { recursive: true });
  const out = outArg ? join(ROOT, outArg) : join(OUTDIR, "today.html");
  writeFileSync(out, html);
  console.log("已渲染:", out);
  console.log("板块:", sections.map((s) => s.title).join(" / ") || "(空)");
}

console.log("\n⚠️ 提交铁律：所有 git 提交必须通过 `node 能力/提交并确认.mjs \"提交信息\"` 执行，禁止直接 git add/commit/push。");
