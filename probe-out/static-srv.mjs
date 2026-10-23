import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || '.';
const PORT = Number(process.argv[3] || 8791);
const BASE = path.resolve(ROOT);
http.createServer((req, res) => {
  const file = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const p = path.join(BASE, file);
  if (!p.startsWith(BASE) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  const type = p.endsWith('.user.js') || p.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/plain; charset=utf-8';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(fs.readFileSync(p));
}).listen(PORT, '127.0.0.1', () => console.log('serving', BASE, 'on', PORT));
