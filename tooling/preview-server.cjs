const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { dirname, extname, resolve, sep } = require('node:path');

const previewPort = 47867;
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

function createPreviewServer(directory) {
  const root = resolve(directory);

  return createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    }

    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const file = resolve(root, extname(pathname) ? '.' + pathname : 'index.html');
      if (!file.startsWith(root + sep)) return response.writeHead(404).end();

      const data = await readFile(file);
      response.writeHead(200, {
        'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
        'Content-Length': data.byteLength,
        'X-Content-Type-Options': 'nosniff',
      });
      return response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      return response.writeHead(404).end();
    }
  });
}

if (require.main === module) {
  const directory = process.argv[2] ?? resolve(dirname(module.filename), 'dist');
  readFile(resolve(directory, 'index.html')).then(() => {
    const server = createPreviewServer(directory);
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error('The demo address is already in use. Close the previous demo window and try again.');
        process.exitCode = 1;
        return;
      }
      console.error(`Could not start the local preview. ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(previewPort, '127.0.0.1', () => {
      console.log(`Open http://127.0.0.1:${previewPort} in your browser.`);
      console.log('Keep this window open while testing. Close it to stop the preview.');
    });
  }, () => {
    console.error('The demo files could not be opened. Extract the entire ZIP or build the web export first.');
    process.exitCode = 1;
  });
}

module.exports = { createPreviewServer };
