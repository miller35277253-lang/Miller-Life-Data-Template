/**
 * 到期计算 —— 唯一共享实现
 * 渲染器与 `数据工具.mjs due` 都从这里取逻辑，避免两套算法漂移。
 * 用法（数据工具.mjs 内）:
 *   node 能力/数据工具.mjs due <YYYY-MM-DD>
 */

const dayNum = (dateStr) => parseInt(dateStr.slice(8, 10), 10);
const seasonOf = (dateStr) => {
  const m = Number(dateStr.slice(5, 7));
  if (m >= 3 && m <= 5) return "spring";
  if (m >= 6 && m <= 8) return "summer";
  if (m >= 9 && m <= 11) return "autumn";
  return "winter";
};
const daysSince = (fromDate, toDate) =>
  Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86400000);

/** 判断单个任务在某日期是否到期 */
export function dueOn(t, dateStr) {
  if (t.status === "completed" || t.status === "paused") return false;

  if (t.type === "project") {
    if (t.startDate === dateStr) return true;
    if (t.startDate && t.startDate <= dateStr && (t.endDate == null || t.endDate >= dateStr)) return true;
    return !!(t.milestones && t.milestones.some((m) => m.due === dateStr));
  }

  if (t.recurrence === "one_time") return t.dueDate === dateStr;

  const d = dayNum(dateStr);

  // 指定日期列表：无法用周期表达的场景（如"每月第一个工作日"落成明确日期）
  if (t.recurrence === "dates") {
    return Array.isArray(t.dueDates) && t.dueDates.includes(dateStr);
  }

  // 每 N 天：从 firstDue 起按天取模，间隔日当天到期
  if (t.recurrence === "days") {
    if (!t.firstDue) return false;
    const diffDays = Math.round((Date.parse(dateStr) - Date.parse(t.firstDue)) / 86400000);
    return diffDays >= 0 && diffDays % (t.intervalDays || 1) === 0;
  }

  // 自定义循环：间隔序列任意（如 [1,2,3,8,6,26,...]），数组和 = 一个完整周期，循环重复
  if (t.recurrence === "cycle") {
    if (!t.firstDue || !Array.isArray(t.cycleDays) || !t.cycleDays.length) return false;
    const diffDays = daysSince(t.firstDue, dateStr);
    if (diffDays < 0) return false;
    const total = t.cycleDays.reduce((a, b) => a + b, 0);
    const pos = diffDays % total;
    if (pos === 0) return true; // firstDue 当天 / 每满一个周期
    let acc = 0;
    for (const gap of t.cycleDays) {
      acc += gap;
      if (pos === acc) return true; // 落在某个间隔边界
    }
    return false;
  }

  // 按季节间隔（绿植等）：距上次养护达到“当前季节”的间隔天数即到期，之后持续显示直到更新 lastWatering
  if (t.recurrence === "seasonal") {
    if (!t.lastWatering || !t.intervalDays) return false;
    const interval = t.intervalDays[seasonOf(dateStr)];
    if (!Number.isInteger(interval) || interval < 1) return false;
    return daysSince(t.lastWatering, dateStr) >= interval;
  }

  if (t.recurrence === "monthly") {
    if (t.remindDay !== d) return false;
    // 有 firstDue 时，首次到期日之前不触发（例：话费 10/1 起，9/1 不应提醒）
    if (t.firstDue && dateStr.slice(0, 7) < t.firstDue.slice(0, 7)) return false;
    return true;
  }

  if (t.recurrence === "interval") {
    if (t.remindDay !== d) return false;
    if (!t.firstDue) return true;
    const [fy, fm] = t.firstDue.slice(0, 7).split("-").map(Number);
    const [cy, cm] = dateStr.slice(0, 7).split("-").map(Number);
    const months = (cy - fy) * 12 + (cm - fm);
    return months >= 0 && months % (t.intervalMonths || 1) === 0;
  }

  // 每日常驻到期（早报/晚报等每天运行项）：任何一天都到期，具体时刻靠 dueTime 展示
  if (t.recurrence === "daily") {
    if (t.firstDue && dateStr < t.firstDue) return false;
    return true;
  }

  return false;
}

/** 返回某日期到期的所有任务 */
export function dueTasks(tasks, dateStr) {
  return tasks.filter((t) => dueOn(t, dateStr));
}

/** 到期任务的展示标签（渲染用） */
export function dueLabel(t, dateStr) {
  let label;
  if (t.type === "project") {
    if (t.milestones && t.milestones.some((m) => m.due === dateStr)) label = "里程碑到期";
    else if (t.startDate === dateStr) label = "项目开始";
    else label = "进行中";
  } else if (t.recurrence === "one_time") {
    label = t.dueDate || "待办";
  } else if (t.recurrence === "dates") {
    label = "指定日期";
  } else if (t.recurrence === "days") {
    label = "每 " + (t.intervalDays || 1) + " 天";
  } else if (t.recurrence === "daily") {
    label = "每日";
  } else if (t.recurrence === "seasonal") {
    label = "距上次养护 " + daysSince(t.lastWatering || dateStr, dateStr) + " 天";
  } else if (t.recurrence === "cycle") {
    label = "自定义循环（周期 " + ((t.cycleDays || []).reduce((a, b) => a + b, 0)) + " 天）";
  } else if (t.recurrence === "monthly") {
    label = "每月 " + t.remindDay + " 日";
  } else if (t.recurrence === "interval") {
    label = "每 " + (t.intervalMonths || 1) + " 个月";
  } else {
    label = "待办";
  }
  // 可选字段 dueTime（HH:MM）：当天到期时在标签末尾显示具体时刻
  if (t.dueTime && /^\d{1,2}:\d{2}$/.test(String(t.dueTime))) {
    label += " " + String(t.dueTime);
  }
  return label;
}

/** 检查任务是否具备可计算的字段；返回问题列表（空数组 = 可计算） */
export function taskIssues(t) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };

  need(t.id, "缺少 id");
  need(t.title, "缺少 title");
  need(["reminder", "confirm", "auto", "project"].includes(t.type), `type 不是合法值（${t.type || "空"}）`);
  need(["active", "paused", "completed", "cancelled"].includes(t.status), `status 不是合法值（${t.status || "空"}）`);

  if (t.type === "project") {
    need(t.startDate && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate), "project 缺少合法 startDate");
    if (t.endDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(t.endDate)) problems.push("endDate 不是合法日期");
    if (t.milestones) {
      t.milestones.forEach((m, i) => {
        need(m.title, `milestones[${i}] 缺少 title`);
        need(m.due && /^\d{4}-\d{2}-\d{2}$/.test(m.due), `milestones[${i}] 缺少合法 due`);
      });
    }
    return problems;
  }

  need(["one_time", "once", "monthly", "interval", "days", "cycle", "dates", "seasonal", "daily"].includes(t.recurrence), `recurrence 不是合法值（${t.recurrence || "空"}）`);
  if (t.recurrence === "one_time") {
    // 事件触发任务（triggerType=event）允许无dueDate，靠关键词/上下文触发
    if (t.triggerType !== "event") {
      need(t.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate), "one_time 任务缺少合法 dueDate（事件触发任务请设 triggerType=event）");
    }
  } else if (t.recurrence === "dates") {
    need(
      Array.isArray(t.dueDates) && t.dueDates.length >= 1 && t.dueDates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
      "dates 任务缺少合法 dueDates（YYYY-MM-DD 数组，至少 1 个）"
    );
  } else if (t.recurrence === "days") {
    need(t.firstDue && /^\d{4}-\d{2}-\d{2}$/.test(t.firstDue), "days 任务缺少合法 firstDue");
    need(Number.isInteger(t.intervalDays) && t.intervalDays >= 1, "days 任务缺少合法 intervalDays（≥1）");
  } else if (t.recurrence === "cycle") {
    need(t.firstDue && /^\d{4}-\d{2}-\d{2}$/.test(t.firstDue), "cycle 任务缺少合法 firstDue");
    need(
      Array.isArray(t.cycleDays) && t.cycleDays.length >= 1 && t.cycleDays.every((n) => Number.isInteger(n) && n >= 1),
      "cycle 任务缺少合法 cycleDays（正整数数组）"
    );
  } else if (t.recurrence === "seasonal") {
    need(t.lastWatering && /^\d{4}-\d{2}-\d{2}$/.test(t.lastWatering), "seasonal 任务缺少合法 lastWatering");
    const iv = t.intervalDays;
    need(
      iv && typeof iv === "object" && ["spring", "summer", "autumn", "winter"].every((k) => Number.isInteger(iv[k]) && iv[k] >= 1),
      "seasonal 任务缺少合法 intervalDays（spring/summer/autumn/winter 均为 ≥1 整数）"
    );
  } else if (t.recurrence === "daily") {
    if (t.firstDue != null) need(/^\d{4}-\d{2}-\d{2}$/.test(t.firstDue), "daily 任务 firstDue 不是合法日期");
  } else {
    need(Number.isInteger(t.remindDay) && t.remindDay >= 1 && t.remindDay <= 31, "周期任务缺少合法 remindDay（1-31）");
    if (t.recurrence === "interval") {
      need(t.firstDue && /^\d{4}-\d{2}-\d{2}$/.test(t.firstDue), "interval 任务缺少合法 firstDue");
      need(Number.isInteger(t.intervalMonths) && t.intervalMonths >= 1, "interval 任务缺少合法 intervalMonths");
    }
  }
  return problems;
}

/** 列出所有不可计算的任务及原因（供 due 命令报警） */
export function uncomputableTasks(tasks) {
  return tasks.flatMap((t) => {
    const issues = taskIssues(t);
    return issues.length ? [{ task: t, issues }] : [];
  });
}
