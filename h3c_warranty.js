#!/usr/bin/env node
'use strict';
/*
 * H3C AP 维保到期日批量查询 —— 命令行入口（零依赖，纯 Node）
 *
 * 用法：
 *   node h3c_warranty.js <序列号文件.txt> [输出CSV.csv]
 *   node h3c_warranty.js                  # 默认读同目录 sns.txt，输出 h3c_warranty_result.csv
 *
 * 具体查询逻辑已抽到 core.js，图形界面服务 server.js 复用同一套引擎。
 * 本文件仅负责命令行参数解析与日志输出，行为与旧版脚本保持一致。
 */

const fs = require('fs');
const path = require('path');
const core = require('./core');

function usage() {
  console.log('H3C AP 维保到期日批量查询 (零依赖纯 Node)\n');
  console.log('用法:');
  console.log('  node h3c_warranty.js <序列号文件.txt> [输出CSV.csv]');
  console.log('  node h3c_warranty.js                      # 默认读同目录 sns.txt，输出 h3c_warranty_result.csv');
  console.log('  node server.js                            # 启动图形化操作平台\n');
  console.log('序列号文件: 每行一个序列号，支持逗号/空格/换行混合，自动去重。');
  console.log('依赖: 仅需 Node >= 12，无需 npm install。');
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) usage();
  const scriptDir = __dirname;
  let inFile, outFile;
  if (args[0]) inFile = path.resolve(scriptDir, args[0]);
  else inFile = path.join(scriptDir, 'sns.txt');
  if (args[1]) outFile = path.resolve(scriptDir, args[1]);
  else outFile = path.join(scriptDir, 'h3c_warranty_result.csv');
  if (!fs.existsSync(inFile)) { console.error('找不到输入文件: ' + inFile); process.exit(1); }

  const sns = core.readSNs(inFile);
  if (!sns.length) { console.error('输入文件中没有有效的序列号。'); process.exit(1); }
  console.log('读取到 ' + sns.length + ' 个序列号，开始查询...\n');

  const result = await core.runQuery(sns, {}, { onLog: m => console.log(m) });
  fs.writeFileSync(outFile, core.buildCSV(result.rows), 'utf8');

  const s = result.stats;
  console.log('\n===== 完成 =====');
  console.log('总数: ' + s.total + '  成功: ' + s.success + '  失败: ' + s.failed);
  console.log('解验证码次数: ' + s.captcha);
  if (s.earliest) {
    console.log('最早维保到期: ' + s.earliest);
    console.log('最晚维保到期: ' + s.latest);
  }
  console.log('结果已写入: ' + outFile);
}

if (require.main === module) {
  main().catch(e => { console.error('致命错误:', e.message || e); process.exit(1); });
}

module.exports = { main };
