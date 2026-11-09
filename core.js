'use strict';
/*
 * H3C 维保查询核心引擎（零依赖，纯 Node 内置模块）
 *
 * 同时供命令行入口 h3c_warranty.js 与图形界面服务 server.js 复用。
 * 相比原脚本新增：
 *   - parseSNs() 解析并给出去重/忽略统计
 *   - runQuery() 支持逐条进度回调、停止信号、请求超时、可调间隔
 *   - buildCSV() 统一生成带 UTF-8 BOM 的 CSV
 *   - 验证码临时图片写入指定目录（默认系统临时目录，不污染项目）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const https = require('https');

const BASE = 'https://es.h3c.com/entitlement';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REF = BASE + '/';
const REQ_TIMEOUT_MS = 20000;

function req(method, url, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'User-Agent': UA, 'Referer': REF };
    if (data) headers['Content-Type'] = 'application/json;charset=UTF-8';
    if (cookie) headers['Cookie'] = cookie;
    const r = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method,
      headers,
      timeout: REQ_TIMEOUT_MS
    }, resp => {
      const chunks = [];
      resp.on('data', d => chunks.push(d));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        setCookie: resp.headers['set-cookie']
      }));
    });
    r.on('timeout', () => r.destroy(new Error('请求超时（20 秒）')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ---------- PNG 解码（zlib，纯手工反滤波）----------
function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, width, height, colorType;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 4;
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    for (let x = 0; x < stride; x++) {
      const rv = raw[p++];
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= ch && y > 0) ? out[(y - 1) * stride + x - ch] : 0;
      let v;
      if (ft === 0) v = rv;
      else if (ft === 1) v = rv + a;
      else if (ft === 2) v = rv + b;
      else if (ft === 3) v = rv + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        v = rv + pr;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, ch, data: out, stride };
}

function lum(img, x, y) { return img.data[y * img.stride + x * img.ch]; }

// 在背景图中定位滑块缺口 X 坐标（= moveLeftDistance）
function detectGap(origFile, jigFile) {
  const orig = decodePNG(origFile), jig = decodePNG(jigFile);
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  const M = [];
  for (let y = 0; y < jig.height; y++) {
    M[y] = [];
    for (let x = 0; x < jig.width; x++) {
      const a = jig.ch === 4 ? jig.data[(y * jig.stride + x * jig.ch) + 3] : 255;
      const on = a > 128;
      M[y][x] = on;
      if (on) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  const boundary = [];
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if (!M[y][x]) continue;
    let edge = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= jig.width || ny >= jig.height || !M[ny][nx]) edge = true;
    }
    if (edge) boundary.push([x, y]);
  }
  // 背景边缘梯度图
  const G = [];
  for (let y = 0; y < orig.height; y++) {
    G[y] = new Float32Array(orig.width);
    for (let x = 0; x < orig.width; x++) {
      const xl = x > 0 ? lum(orig, x - 1, y) : lum(orig, x, y);
      const xr = x < orig.width - 1 ? lum(orig, x + 1, y) : lum(orig, x, y);
      const yt = y > 0 ? lum(orig, x, y - 1) : lum(orig, x, y);
      const yb = y < orig.height - 1 ? lum(orig, x, y + 1) : lum(orig, x, y);
      G[y][x] = Math.abs(xr - xl) + Math.abs(yb - yt);
    }
  }
  let best = -1, bestScore = -1;
  for (let ox = 0; ox <= orig.width - (maxX - minX + 1); ox++) {
    let s = 0;
    for (const [px, py] of boundary) { const X = ox + px; if (X >= 0 && X < orig.width) s += G[py][X]; }
    if (s > bestScore) { bestScore = s; best = ox; }
  }
  return best + minX;
}

// AES-ECB(PKCS7) Base64 —— 与华三前端逻辑一致
function aesEncrypt(word, keyWord) {
  const key = Buffer.from(keyWord, 'utf8');
  const algo = key.length === 16 ? 'aes-128-ecb' : key.length === 24 ? 'aes-192-ecb' : 'aes-256-ecb';
  const c = crypto.createCipheriv(algo, key, null);
  c.setAutoPadding(true);
  return Buffer.concat([c.update(Buffer.from(word, 'utf8')), c.final()]).toString('base64');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function solveCaptcha(tmpDir, log) {
  const say = typeof log === 'function' ? log : () => {};
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      let jar = '';
      const cap = await req('POST', BASE + '/captcha/get', { captchaType: 'blockPuzzle' }, jar);
      const j = JSON.parse(cap.body);
      if (j.repCode !== '0000') throw new Error('captcha/get repCode=' + j.repCode);
      const d = j.repData;
      if (cap.setCookie) jar = cap.setCookie.map(x => x.split(';')[0]).join('; ');
      fs.mkdirSync(tmpDir, { recursive: true });
      const origFile = path.join(tmpDir, '_cap_orig.png');
      const jigFile = path.join(tmpDir, '_cap_jig.png');
      fs.writeFileSync(origFile, Buffer.from(d.originalImageBase64, 'base64'));
      fs.writeFileSync(jigFile, Buffer.from(d.jigsawImageBase64, 'base64'));
      const X = detectGap(origFile, jigFile);
      const point = JSON.stringify({ x: X, y: 5.0 });
      const pointJson = aesEncrypt(point, d.secretKey);
      const cv = aesEncrypt(d.token + '---' + point, d.secretKey);
      const check = await req('POST', BASE + '/captcha/check',
        { captchaType: 'blockPuzzle', pointJson, token: d.token, clientUid: 'uid-' + Date.now(), ts: Date.now() }, jar);
      if (check.setCookie) jar = check.setCookie.map(x => x.split(';')[0]).join('; ');
      const cj = JSON.parse(check.body);
      if (cj.repCode !== '0000' && !cj.success) throw new Error('captcha/check failed repCode=' + cj.repCode + ' success=' + cj.success);
      return { cv, jar };
    } catch (e) {
      lastErr = e;
      say('  [验证码重试 ' + attempt + '/4] ' + e.message);
      await sleep(2000);
    }
  }
  throw new Error('验证码连续失败: ' + (lastErr && lastErr.message));
}

async function querySN(sn, cv, jar) {
  const url = BASE + '/query/sdms/' + encodeURIComponent(sn) + '?captchaVerification=' + encodeURIComponent(cv);
  const r = await req('GET', url, null, jar);
  let obj = null;
  try { obj = JSON.parse(r.body); } catch (e) { /* 非 JSON 时用正则兜底 */ }
  const code = (obj && obj.code != null) ? obj.code : (r.body.match(/"code":(\d+)/) || [])[1];
  let end = null;
  if (obj && obj.data) end = obj.data.newEndDate || obj.data.expDate || obj.data.endDate || null;
  if (!end) end = (r.body.match(/"newEndDate":"([^"]*)"/) || [])[1] || null;
  return { code: code != null ? String(code) : '', end, raw: r.body };
}

/**
 * 解析序列号文本：支持换行 / 逗号 / 空格 / 中文逗号混排，自动清洗去重。
 * @returns {{sns: string[], total: number, duplicates: number, ignored: number}}
 */
function parseSNs(text) {
  const tokens = String(text == null ? '' : text)
    .split(/[\r\n,，\s]+/).map(s => s.trim()).filter(Boolean);
  const set = new Set();
  const sns = [];
  let duplicates = 0, ignored = 0;
  for (const t of tokens) {
    const clean = t.replace(/[^A-Za-z0-9]/g, '');
    if (clean.length < 4) { ignored++; continue; }
    if (set.has(clean)) { duplicates++; continue; }
    set.add(clean);
    sns.push(clean);
  }
  return { sns, total: tokens.length, duplicates, ignored };
}

/** 兼容原 CLI：从文件读取并解析序列号 */
function readSNs(file) {
  return parseSNs(fs.readFileSync(file, 'utf8')).sns;
}

function csvCell(s) {
  s = String(s == null ? '' : s);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 生成与原脚本一致的 CSV（带 BOM），列为：序列号,保修到期日,备注 */
function buildCSV(rows) {
  const lines = ['\uFEFF序列号,保修到期日,备注'];
  for (const r of rows) lines.push([r.sn, r.end || '', r.note || ''].map(csvCell).join(','));
  return lines.join('\r\n');
}

/** 到期日剩余天数（按自然日，负数表示已过保） */
function daysLeft(end) {
  if (!end) return null;
  const m = String(end).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const today = new Date();
  const t0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const t1 = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Math.round((t1 - t0) / 86400000);
}

/**
 * 批量查询主流程。
 * @param {string[]} sns
 * @param {object} opts  { intervalMs, maxCaptcha, retry, tmpDir, autoCaptcha }
 * @param {object} hooks { onLog(msg), onRow(row, index, total), onStats(stats), shouldStop() }
 * @returns {Promise<{rows, solves, failed, stopped, stats}>}
 */
async function runQuery(sns, opts, hooks) {
  const o = Object.assign({
    intervalMs: 350,
    maxCaptcha: 60,
    retry: 4,
    tmpDir: path.join(os.tmpdir(), 'h3c-warranty-gui'),
    autoCaptcha: true
  }, opts || {});
  const h = hooks || {};
  const log = typeof h.onLog === 'function' ? h.onLog : () => {};
  const emitStats = typeof h.onStats === 'function' ? h.onStats : () => {};
  const stopped = () => typeof h.shouldStop === 'function' && h.shouldStop();

  const rows = [];
  let solves = 0, failed = 0, wasStopped = false;
  const stats = () => {
    const dates = rows.map(r => r.end).filter(Boolean).sort();
    return {
      total: sns.length,
      done: rows.length,
      success: rows.length - failed,
      failed,
      captcha: solves,
      earliest: dates[0] || '',
      latest: dates[dates.length - 1] || '',
      percent: sns.length ? Math.round(rows.length / sns.length * 100) : 0
    };
  };
  const emit = () => emitStats(stats());

  let cv, jar;
  log('正在初始化滑块验证码…');
  const first = await solveCaptcha(o.tmpDir, log);
  cv = first.cv; jar = first.jar; solves = 1;
  log('验证码通过，开始逐台查询（共 ' + sns.length + ' 台）');
  emit();

  for (let i = 0; i < sns.length; i++) {
    if (stopped()) { wasStopped = true; log('收到停止指令，正在收尾…'); break; }
    const sn = sns[i];
    let end = '', note = '';
    for (let attempt = 0; attempt < o.retry && !end; attempt++) {
      try {
        const res = await querySN(sn, cv, jar);
        if (res.code === '429') {
          if (o.autoCaptcha && solves < o.maxCaptcha) {
            log('  [' + (i + 1) + '/' + sns.length + '] 触发限频 429，重新解验证码 #' + (solves + 1));
            const again = await solveCaptcha(o.tmpDir, log);
            cv = again.cv; jar = again.jar; solves++;
            emit();
            continue;
          }
          note = '频繁限频，已达验证码上限';
          break;
        }
        if (res.code === '200' && res.end) { end = res.end; break; }
        note = 'code=' + res.code + (res.end ? (' end=' + res.end) : ' 无到期日');
        await sleep(500);
      } catch (e) {
        note = '网络错误:' + e.message;
        await sleep(800);
      }
    }
    const row = { index: i + 1, sn, end, note };
    rows.push(row);
    if (!end) failed++;
    log(String(i + 1).padStart(4) + '/' + sns.length + '  ' + sn + '  ' + (end || ('✗ ' + note)));
    if (h.onRow) h.onRow(row, i + 1, sns.length);
    emit();
    if (!stopped()) await sleep(Math.max(0, Number(o.intervalMs) || 0));
  }
  return { rows, solves, failed, stopped: wasStopped, stats: stats() };
}

module.exports = {
  BASE,
  parseSNs,
  readSNs,
  csvCell,
  buildCSV,
  daysLeft,
  solveCaptcha,
  querySN,
  runQuery,
  sleep
};
