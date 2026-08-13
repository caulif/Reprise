import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const htmlDir = join(process.cwd(), 'docs', 'tui-audit', 'html');
const shotDir = join(process.cwd(), 'docs', 'tui-audit', 'screenshots');

const files = (await readdir(htmlDir)).filter((name) => name.endsWith('.html')).sort();
await mkdir(shotDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
});

for (const file of files) {
  const url = pathToFileURL(join(htmlDir, file)).href;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const box = await page.locator('.wrap').boundingBox();
  const width = Math.max(1280, Math.ceil((box?.width ?? 1200) + 40));
  const height = Math.max(400, Math.ceil((box?.height ?? 600) + 40));
  await page.setViewportSize({ width, height });
  const name = file.replace(/\.html$/, '.png');
  await page.screenshot({ path: join(shotDir, name), fullPage: true });
  console.log(`screenshot ${name} ${width}x${height}`);
}

await browser.close();
console.log(`wrote ${files.length} screenshots to ${shotDir}`);
