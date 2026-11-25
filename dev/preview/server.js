// dev/preview/server.js — serves the popup preview so you can look at the UI.
// Run:  node dev/preview/server.js   then open http://localhost:8099/
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..', '..', 'extension');
const PREVIEW = path.join(__dirname, 'popup-preview.html');
const PORT = Number(process.env.PORT || 8099);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  try {
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': TYPES['.html'] });
      res.end(fs.readFileSync(PREVIEW));
      return;
    }
    // Serve the extension files the preview refers to. The path is cleaned
    // so a request can never reach outside the extension folder.
    const relative = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
    const file = path.join(EXT, relative);
    if (!path.resolve(file).startsWith(path.resolve(EXT)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server problem: ' + err.message);
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('Popup preview: http://localhost:' + PORT + '/');
  console.log('Press Ctrl+C to stop.');
});
