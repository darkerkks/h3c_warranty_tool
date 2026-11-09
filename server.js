'use strict';
/*
 * H3C 维保查询工作台 —— 本地图形化服务（零依赖，纯 Node 内置模块）
 *
 * 启动：node server.js   然后浏览器访问终端里打印的地址（默认自动打开）
 * 只监听 127.0.0.1，不对外暴露；无数据库、无第三方包。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const core = require('./core');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const RESULTS = path.join(ROOT, 'results');
const START_PORT = Number(process.env.H3C_PORT || 8787);
const AUTO_BROWSER = !process.argv.includes('--no-browser');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---------------- 任务状态 ----------------
let job = null;
let jobSeq = 0;
const clients = new Set();
let broadcastTimer = null;

function emptyStats(total) {
  return { total: total || 0, done: 0, success: 0, failed: 0, captcha: 0, earliest: '', latest: '', percent: 0 };
}

function snapshot() {
  return {
    jobId: job ? job.id : '',
    status: job ? job.status : 'idle',   // idle | running | done | stopped | error
    sns: job ? job.sns : [],
    options: job ? job.options : {},
    rows: job ? job.rows : [],
    logs: job ? job.logs : [],
    stats: job ? job.stats : emptyStats(0),
    current: job ? job.current : '',
    message: job ? job.message : '',
    startedAt: job ? job.startedAt : null,
    finishedAt: job ? job.finishedAt : null
  };
}

function broadcastNow() {
  if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
  const payload = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of clients) {
    try { res.write(payload); } catch (e) { clients.delete(res); }
  }
}
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(broadcastNow, 70);
}

function addLog(msg) {
  if (!job) return;
  job.logs.push(msg);
  if (job.logs.length > 400) job.logs.shift();
  scheduleBroadcast();
}

function saveResult(res) {
  try {
    fs.mkdirSync(RESULTS, { recursive: true });
    const id = (job && job.id) || ('job-' + Date.now());
    const data = {
      id,
      savedAt: new Date().toISOString(),
      options: job ? job.options : {},
      stats: res.stats,
      rows: res.rows
    };
    fs.writeFileSync(path.join(RESULTS, id + '.json'), JSON.stringify(data, null, 2), 'utf8');
    fs.writeFileSync(path.join(RESULTS, id + '.csv'), core.buildCSV(res.rows), 'utf8');
  } catch (e) {
    addLog('  [提示] 历史结果保存失败: ' + e.message);
  }
}

function startJob(sns, options) {
  if (job && job.status === 'running') return { error: '已有任务正在运行，请先停止或等待完成' };
  const o = Object.assign({
    intervalMs: 350,
    maxCaptcha: 60,
    retry: 4,
    autoCaptcha: true,
    warningDays: 90,
    tmpDir: path.join(os.tmpdir(), 'h3c-warranty-gui')
  }, options || {});
  o.intervalMs = Math.min(Math.max(Number(o.intervalMs) || 0, 0), 10000);
  o.retry = Math.min(Math.max(Number(o.retry) || 1, 1), 10);
  o.maxCaptcha = Math.min(Math.max(Number(o.maxCaptcha) || 1, 1), 200);
  o.warningDays = Math.min(Math.max(Number(o.warningDays) || 90, 1), 3650);

  jobSeq++;
  job = {
    id: new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + jobSeq,
    status: 'running',
    sns,
    options: o,
    rows: [],
    logs: [],
    stats: emptyStats(sns.length),
    current: '',
    message: '',
    startedAt: Date.now(),
    finishedAt: null,
    stopRequested: false
  };
  addLog('任务 ' + job.id + ' 已创建，待查询 ' + sns.length + ' 台设备');
  broadcastNow();

  core.runQuery(sns, o, {
    onLog: addLog,
    onRow: row => { job.rows.push(row); job.current = row.sn; scheduleBroadcast(); },
    onStats: s => { job.stats = s; scheduleBroadcast(); },
    shouldStop: () => job && job.stopRequested
  }).then(res => {
    job.stats = res.stats;
    job.status = res.stopped ? 'stopped' : 'done';
    job.message = res.stopped
      ? '已手动停止，保留已完成的前 ' + res.rows.length + ' 条结果'
      : '查询完成：成功 ' + res.stats.success + ' 台，失败 ' + res.stats.failed + ' 台';
    job.finishedAt = Date.now();
    job.current = '';
    addLog('\n===== ' + (res.stopped ? '已停止' : '完成') + ' =====');
    addLog('总数: ' + res.stats.total + '  成功: ' + res.stats.success + '  失败: ' + res.stats.failed);
    addLog('解验证码次数: ' + res.solves);
    if (res.stats.earliest) {
      addLog('最早维保到期: ' + res.stats.earliest);
      addLog('最晚维保到期: ' + res.stats.latest);
    }
    saveResult(res);
    broadcastNow();
  }).catch(err => {
    job.status = 'error';
    job.message = err && (err.message || String(err)) || '未知错误';
    job.finishedAt = Date.now();
    job.current = '';
    addLog('致命错误: ' + job.message);
    if (job.rows.length) saveResult({ rows: job.rows, stats: job.stats });
    broadcastNow();
  });

  return { jobId: job.id };
}

// ---------------- 工具函数 ----------------
function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function loadDemoRows() {
  const file = path.join(ROOT, 'result_84.csv');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = parseCsvLine(lines[i]);
    rows.push({ index: rows.length + 1, sn: c[0] || '', end: c[1] || '', note: c[2] || '' });
  }
  return rows;
}

function levelOf(row, warningDays) {
  if (!row.end) return 'unknown';
  const d = core.daysLeft(row.end);
  if (d == null) return 'unknown';
  if (d < 0) return 'expired';
  if (d <= warningDays) return 'urgent';
  if (d <= 365) return 'soon';
  return 'safe';
}
const LEVEL_TEXT = { expired: '已过保', urgent: '临近到期', soon: '一年内到期', safe: '一年以上', unknown: '查询失败' };

function buildFullCSV(rows, warningDays) {
  const head = ['序列号', '保修到期日', '剩余天数', '预警状态', '备注'];
  const lines = ['\uFEFF' + head.join(',')];
  for (const r of rows) {
    const d = core.daysLeft(r.end);
    lines.push([r.sn, r.end || '', d == null ? '' : d, LEVEL_TEXT[levelOf(r, warningDays)], r.note || ''].map(core.csvCell).join(','));
  }
  return lines.join('\r\n');
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // 目录穿越防护：只允许 public 下的已知文件
  if (!/^[A-Za-z0-9._-]+$/.test(rel)) { res.writeHead(403); res.end('Forbidden'); return; }
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found'); return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
}

// ---------------- 路由 ----------------
async function handle(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/status' && req.method === 'GET') {
    return sendJSON(res, 200, {
      ok: true, node: process.version, platform: process.platform,
      running: !!(job && job.status === 'running'),
      hasResult: !!(job && job.rows.length), port: res.socket.localPort, dir: ROOT
    });
  }

  // 全量状态快照（与 SSE 推送内容一致，便于排查与外部集成）
  if (p === '/api/state' && req.method === 'GET') {
    return sendJSON(res, 200, snapshot());
  }

  if (p === '/api/parse' && req.method === 'POST') {
    const b = await readBody(req);
    return sendJSON(res, 200, core.parseSNs(b.text));
  }

  if (p === '/api/start' && req.method === 'POST') {
    const b = await readBody(req);
    const raw = Array.isArray(b.sns) ? b.sns.join('\n') : (b.text || '');
    const sns = core.parseSNs(raw).sns;   // 统一清洗 + 去重，不信任外部传入
    if (!sns.length) return sendJSON(res, 400, { error: '没有有效的序列号' });
    const r = startJob(sns, b.options);
    return sendJSON(res, r.error ? 409 : 200, r);
  }

  if (p === '/api/stop' && req.method === 'POST') {
    if (!job || job.status !== 'running') return sendJSON(res, 400, { error: '当前没有运行中的任务' });
    job.stopRequested = true;
    addLog('正在请求停止…（会在当前这台查询结束后停下）');
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/reset' && req.method === 'POST') {
    if (job && job.status === 'running') return sendJSON(res, 409, { error: '任务运行中，无法清空' });
    job = null;
    broadcastNow();
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/demo' && req.method === 'GET') {
    let input = '';
    const f = path.join(ROOT, 'sns.txt');
    if (fs.existsSync(f)) input = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    return sendJSON(res, 200, { input, rows: loadDemoRows() });
  }

  // 把示例结果载入为「已完成任务」，用于离线预览整套界面（不发真实请求）
  if (p === '/api/demo/load' && req.method === 'POST') {
    if (job && job.status === 'running') return sendJSON(res, 409, { error: '任务运行中，无法载入演示数据' });
    const rows = loadDemoRows();
    const dates = rows.map(r => r.end).filter(Boolean).sort();
    const success = dates.length;
    job = {
      id: 'demo-' + Date.now(), status: 'done',
      sns: rows.map(r => r.sn), options: { warningDays: 90 },
      rows, logs: ['已载入演示结果（' + rows.length + ' 条，离线预览，未发起真实查询）'],
      stats: {
        total: rows.length, done: rows.length, success,
        failed: rows.length - success, captcha: 0,
        earliest: dates[0] || '', latest: dates[dates.length - 1] || '', percent: 100
      },
      current: '', message: '演示数据：' + rows.length + ' 条示例结果',
      startedAt: Date.now(), finishedAt: Date.now(), stopRequested: false
    };
    broadcastNow();
    return sendJSON(res, 200, { ok: true, count: rows.length });
  }

  if (p === '/api/export' && req.method === 'GET') {
    const rows = job ? job.rows : [];
    const mode = u.searchParams.get('mode') === 'full' ? 'full' : 'standard';
    const wd = Number(u.searchParams.get('warningDays')) || 90;
    const csv = mode === 'full' ? buildFullCSV(rows, wd) : core.buildCSV(rows);
    const name = mode === 'full' ? 'h3c_warranty_full_report.csv' : 'h3c_warranty_result.csv';
    const body = Buffer.from(csv, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + name + '"',
      'Content-Length': body.length
    });
    return res.end(body);
  }

  if (p === '/api/history' && req.method === 'GET') {
    fs.mkdirSync(RESULTS, { recursive: true });
    const list = fs.readdirSync(RESULTS).filter(f => /^[\w-]+\.json$/.test(f)).sort().reverse().slice(0, 30);
    const items = [];
    for (const f of list) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8'));
        items.push({ id: d.id, savedAt: d.savedAt, count: (d.rows || []).length, success: (d.stats || {}).success, failed: (d.stats || {}).failed });
      } catch (e) { /* 跳过损坏文件 */ }
    }
    return sendJSON(res, 200, { items });
  }

  if (p === '/api/history/item' && req.method === 'GET') {
    const id = u.searchParams.get('id') || '';
    if (!/^[\w-]+$/.test(id)) return sendJSON(res, 400, { error: '非法 ID' });
    const f = path.join(RESULTS, id + '.json');
    if (!fs.existsSync(f)) return sendJSON(res, 404, { error: '记录不存在' });
    return sendJSON(res, 200, JSON.parse(fs.readFileSync(f, 'utf8')));
  }

  // 把某条历史记录载入为当前结果，便于再次查看 / 导出
  if (p === '/api/history/load' && req.method === 'POST') {
    const b = await readBody(req);
    const id = String(b.id || '');
    if (!/^[\w-]+$/.test(id)) return sendJSON(res, 400, { error: '非法 ID' });
    const f = path.join(RESULTS, id + '.json');
    if (!fs.existsSync(f)) return sendJSON(res, 404, { error: '记录不存在' });
    if (job && job.status === 'running') return sendJSON(res, 409, { error: '任务运行中，无法载入历史' });
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    job = {
      id: d.id, status: 'done', sns: (d.rows || []).map(r => r.sn),
      options: Object.assign({ warningDays: 90 }, d.options || {}),
      rows: d.rows || [], logs: ['已载入历史记录 ' + d.id],
      stats: d.stats || emptyStats((d.rows || []).length),
      current: '', message: '历史记录：' + d.id,
      startedAt: Date.parse(d.savedAt) || Date.now(), finishedAt: Date.now(), stopRequested: false
    };
    broadcastNow();
    return sendJSON(res, 200, { ok: true });
  }

  if (p.startsWith('/api/')) return sendJSON(res, 404, { error: '接口不存在' });
  return serveStatic(res, p);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (!res.headersSent) sendJSON(res, 500, { error: err.message || String(err) });
    else res.end();
  });
});

// SSE 心跳，避免长时间无数据被浏览器/代理断开
setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); }
  }
}, 20000).unref();

let port = START_PORT;
let tries = 0;
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && tries++ < 12) {
    port++;
    server.listen(port, '127.0.0.1');
  } else {
    console.error('服务启动失败:', err.message);
    process.exit(1);
  }
});

server.listen(port, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + port + '/';
  console.log('');
  console.log('  H3C 维保查询工作台已启动');
  console.log('  ------------------------------------------');
  console.log('  访问地址: ' + url);
  console.log('  工作目录: ' + ROOT);
  console.log('  按 Ctrl+C 关闭服务');
  console.log('  ------------------------------------------');
  console.log('');
  if (AUTO_BROWSER) {
    const cmd = process.platform === 'win32'
      ? 'start "" "' + url + '"'
      : (process.platform === 'darwin' ? 'open "' + url + '"' : 'xdg-open "' + url + '"');
    exec(cmd, () => {});
  }
});
