#!/usr/bin/env node
/**
 * 全局时区真相源
 *
 * 系统所有时间/日期的判断，一律以「个人档案.json 里的 timezone 字段」为准，
 * 禁止在各脚本中硬编码 Asia/Shanghai，也禁止使用 toISOString()（UTC）。
 *
 * 用法：
 *   import { TZ, nowDate, nowTime, toLocalDate } from "./时区.mjs";
 *
 * 输出示例（档案时区为 Asia/Shanghai）：
 *   TZ        = "Asia/Shanghai"
 *   nowDate() = "2026-09-07"
 *   nowTime() = "2026-09-07T01:20:00"        （本地时间，不含偏移）
 *   nowTime() = "2026-09-07T01:20:00+08:00"  （本地时间，含偏移，爬取存储用）
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_PATH = join(ROOT, "个人档案.json");

export const TZ = (() => {
  try {
    if (existsSync(PROFILE_PATH)) {
      const profile = JSON.parse(readFileSync(PROFILE_PATH, "utf8"));
      if (profile && profile.timezone) return profile.timezone;
    }
  } catch (e) {
    /* 读取失败回退默认 */
  }
  return "Asia/Shanghai";
})();

/** 当前档案时区下格式化到任意精度（字段为 part 的 type） */
function localParts(fields) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    ...fields,
  }).formatToParts(new Date());
}
const get = (parts, t) => parts.find((p) => p.type === t)?.value || "00";

/** 当前本地日期 YYYY-MM-DD */
export function nowDate() {
  const p = localParts({ year: "numeric", month: "2-digit", day: "2-digit" });
  return `${get(p, "year")}-${get(p, "month")}-${get(p, "day")}`;
}

/** 当前本地时间（不含偏移） YYYY-MM-DDTHH:mm:ss */
export function nowLocalDatetime() {
  const p = localParts({
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  return `${get(p, "year")}-${get(p, "month")}-${get(p, "day")}T${get(p, "hour")}:${get(p, "minute")}:${get(p, "second")}`;
}

/** 计算档案时区当前 UTC 偏移字符串（+08:00 / +05:30 / -07:00 ...） */
export function offsetStr() {
  // 对于固定偏移时区（大部分中国/新加坡等），直接映射；通用时区用 Intl 计算
  const now = new Date();
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = dtf.formatToParts(now);
  const y = Number(get(parts, "year")), mo = Number(get(parts, "month")), d = Number(get(parts, "day"));
  const h = Number(get(parts, "hour")), mi = Number(get(parts, "minute")), s = Number(get(parts, "second"));
  const localAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // localAsUtc 是「把本地墙钟当 UTC 的毫秒」，它与真实 UTC 的差 = 偏移（分钟）
  const offsetMin = Math.round((localAsUtc - now.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** 当前完整本地时间戳 YYYY-MM-DDTHH:mm:ss+偏移（存储历史用） */
export function nowTime() {
  return `${nowLocalDatetime()}${offsetStr()}`;
}

/** 计算指定时刻在档案时区下的 UTC 偏移（±HH:MM），用于校验历史时间戳 */
export function offsetForAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const y = Number(get(parts, "year")), mo = Number(get(parts, "month")), dd = Number(get(parts, "day"));
  const h = Number(get(parts, "hour")), mi = Number(get(parts, "minute")), s = Number(get(parts, "second"));
  const asUtc = Date.UTC(y, mo - 1, dd, h, mi, s);
  const min = Math.round((asUtc - d.getTime()) / 60000);
  const sign = min >= 0 ? "+" : "-";
  const abs = Math.abs(min);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** 把任意时间戳按档案时区换算成本地日期 YYYY-MM-DD */
export function toLocalDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(d).split("/").join("-");
}