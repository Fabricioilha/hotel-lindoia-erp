import { copyFile } from 'node:fs/promises';
for (const file of ['_worker.js', '_routes.json']) {
  await copyFile(new URL(`../cloudflare/${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
}
console.log('dist preparado para Cloudflare Pages (incluindo a ponte de checkout).');
