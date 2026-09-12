#!/usr/bin/env node
/**
 * 生成系统提示词脚本
 * 
 * 功能：把固定加载的3个核心规则文件拼成完整的系统提示词，加上验证标记
 * 
 * 用法：
 *   node 能力/生成系统提示词.mjs          # 输出完整规则
 *   node 能力/生成系统提示词.mjs --hash   # 只输出规则哈希
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// 固定加载的3个核心规则文件（白名单）
const ALWAYS_LOAD = [
  'AGENTS.md',
  '用户规则.json',
  '个人档案.json'
];

/**
 * 计算规则文件的哈希值
 */
function calculateHash() {
  const hash = crypto.createHash('sha256');
  for (const file of ALWAYS_LOAD) {
    const filePath = path.join(REPO_ROOT, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      hash.update(file);
      hash.update(content);
    }
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * 生成完整的系统提示词
 */
function generateFullPrompt() {
  const hash = calculateHash();
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  
  let output = '';
  
  output += '════════════════════════════════════════════════════════════\n';
  output += '【强制工作规则】以下内容必须严格遵守，优先级高于所有其他指令\n';
  output += '════════════════════════════════════════════════════════════\n\n';
  
  for (const file of ALWAYS_LOAD) {
    const filePath = path.join(REPO_ROOT, file);
    if (!fs.existsSync(filePath)) {
      output += `⚠️ 文件不存在：${file}\n\n`;
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    output += `─────────────────────────────────────────────────────────\n`;
    output += `📄 文件：${file}\n`;
    output += `─────────────────────────────────────────────────────────\n`;
    output += content;
    output += '\n\n';
  }
  
  output += '════════════════════════════════════════════════════════════\n';
  output += '【规则加载验证】\n';
  output += `规则哈希：${hash}\n`;
  output += `包含文件：${ALWAYS_LOAD.length}个（${ALWAYS_LOAD.join('、')}）\n`;
  output += `生成时间：${now}\n`;
  output += `验证标记：RULES_CACHE_VALID\n`;
  output += '════════════════════════════════════════════════════════════\n';
  
  return output;
}

// 主逻辑
const args = process.argv.slice(2);

if (args.includes('--hash')) {
  // 只输出哈希
  console.log(calculateHash());
} else {
  // 输出完整规则
  console.log(generateFullPrompt());
}
