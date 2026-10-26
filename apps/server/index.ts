import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express from 'express';
import { existsSync } from 'node:fs';
import { Store } from '../../packages/data/store.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', ...(import.meta.url.includes('/dist/') ? ['..'] : []));
const store = new Store(resolve(root, '.local', 'metrics.sqlite'));
const { app, coordinator } = createApp({ port, store });
const production = import.meta.url.includes('/dist/');
if (production) {
  const web = resolve(root, 'dist', 'web');
  if (!existsSync(web)) throw new Error('Web build not found. Run npm run build before npm start.');
  app.use(express.static(web, { index: false }));
  app.use((req, res) => {
    if (req.method !== 'GET') { res.sendStatus(404); return; }
    res.sendFile(resolve(web, 'index.html'));
  });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, host: '127.0.0.1', hmr: { port: port + 1, host: '127.0.0.1' } }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = app.listen(port, '127.0.0.1', () => console.log(`GitHub Engineering Insights ready at http://127.0.0.1:${port}`));
server.on('error', error => {
  console.error('Could not start loopback server:', error.message);
  store.close();
  process.exitCode = 1;
});
for (const event of ['SIGINT', 'SIGTERM'] as const) {
  process.once(event, () => {
    coordinator.cancel();
    server.close(() => {
      void coordinator.settled().finally(() => { store.close(); process.exit(0); });
    });
  });
}
