// 果酱派对 · 后端 + 静态站点托管（零依赖，原生 Node）
// 与前端在同一个仓库；服务器 git pull 后：`node server.js`（建议 pm2 常驻）。
// 页面：  http://你的IP/            （托管本仓库根目录的 index.html、img/、music/）
// 接口：
//   POST /api/enter   body {name, identity}         -> 报名上墙，返回 {ok,count}
//   GET  /api/wall                                   -> {ok,count,guests:[{name,identity,ts}]}
//   GET  /api/admin?key=YOUR_ADMIN_KEY[&format=csv]  -> 全量名单（管理用）
//
// 环境变量（可选）：
//   PORT=80                  监听端口（对外直接用 80）
//   ADMIN_KEY=xxxx           查看/导出全量名单的口令（务必自设）
//   DATA_FILE=./guests.json  数据文件路径
//   STATIC_DIR=.            静态站点目录（默认=本文件所在目录=仓库根）

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 80;
const ADMIN_KEY = process.env.ADMIN_KEY || 'jamparty-admin';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'guests.json');
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'stats.json');
const STATIC_DIR = path.normalize(process.env.STATIC_DIR || __dirname);

const IDS = ['灯塔', '同谋', '远山', '江湖', '炉火'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
// 禁止被当静态文件下载的（保护名单与源码）
const DENY = ['server.js', 'guests.json', 'stats.json', '部署说明.md', 'README.md'];

function load() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return []; } }
function save(list) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2)); } catch (e) { console.error('save fail', e.message); } }
let guests = load();

// 埋点数据：pv 计数、uv(去重访客集合)、停留时长(每访客取最大心跳值)
function loadStats() {
  try { const s = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); s.pv = s.pv || 0; s.uv = s.uv || {}; s.dwell = s.dwell || {}; return s; }
  catch (e) { return { pv: 0, uv: {}, dwell: {} }; }
}
let stats = loadStats();
let statsDirty = false;
function saveStats() { if (!statsDirty) return; statsDirty = false;
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch (e) { console.error('stats save fail', e.message); } }
setInterval(saveStats, 5000); // 批量落盘，避免高频写

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function clean(s, max) { return String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, max); }

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const fp = path.normalize(path.join(STATIC_DIR, rel));
  // 防目录穿越 + 屏蔽敏感文件/隐藏目录
  const base = path.basename(fp);
  if (!fp.startsWith(STATIC_DIR) || rel.indexOf('/.') >= 0 || DENY.indexOf(base) >= 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('forbidden');
  }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && u.pathname === '/api/wall') {
    return json(res, 200, { ok: true, count: guests.length,
      guests: guests.map(g => ({ name: g.name, identity: g.identity, ts: g.ts })) });
  }

  if (req.method === 'POST' && u.pathname === '/api/enter') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      let p; try { p = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { ok: false, err: 'bad json' }); }
      const name = clean(p.name, 12);
      const identity = IDS.includes(p.identity) ? p.identity : '';
      if (!name || !identity) return json(res, 400, { ok: false, err: 'need name & valid identity' });
      const now = Date.now();
      const dup = guests.find(g => g.name === name && g.identity === identity && now - g.ts < 600000);
      if (!dup) { guests.push({ name, identity, ts: now }); save(guests); }
      return json(res, 200, { ok: true, count: guests.length });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/track') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      let p; try { p = JSON.parse(body || '{}'); } catch (e) { return json(res, 200, { ok: false }); }
      const vid = clean(p.vid, 40);
      if (!vid) return json(res, 200, { ok: false });
      if (p.t === 'pv') { stats.pv++; if (!stats.uv[vid]) stats.uv[vid] = Date.now(); statsDirty = true; }
      else if (p.t === 'ping' || p.t === 'leave') {
        const d = Math.max(0, Math.min(86400, parseInt(p.dwell, 10) || 0));
        if (d > (stats.dwell[vid] || 0)) { stats.dwell[vid] = d; statsDirty = true; } // 取该访客最长停留
      }
      return json(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/stats') {
    if (u.searchParams.get('key') !== ADMIN_KEY) return json(res, 403, { ok: false, err: 'forbidden' });
    const uv = Object.keys(stats.uv).length;
    const dwells = Object.values(stats.dwell);
    const sum = dwells.reduce((a, b) => a + b, 0);
    const avg = dwells.length ? Math.round(sum / dwells.length) : 0;
    const sorted = dwells.slice().sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const over30 = dwells.filter(d => d >= 30).length;
    return json(res, 200, { ok: true, pv: stats.pv, uv: uv,
      dwell: { avg_sec: avg, median_sec: median, samples: dwells.length, over_30s: over30 } });
  }

  if (req.method === 'GET' && u.pathname === '/api/admin') {
    if (u.searchParams.get('key') !== ADMIN_KEY) return json(res, 403, { ok: false, err: 'forbidden' });
    if (u.searchParams.get('format') === 'csv') {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
      const rows = ['姓名,身份,登记时间'].concat(
        guests.map(g => `${g.name},${g.identity},${new Date(g.ts).toLocaleString('zh-CN')}`));
      return res.end('﻿' + rows.join('\n'));
    }
    return json(res, 200, { ok: true, count: guests.length, guests });
  }

  if (req.method === 'GET') return serveStatic(req, res, u.pathname);
  json(res, 404, { ok: false, err: 'not found' });
});

server.listen(PORT, () => console.log('果酱派对 已启动 :' + PORT + ' | 静态 ' + STATIC_DIR + ' | 数据 ' + DATA_FILE));
