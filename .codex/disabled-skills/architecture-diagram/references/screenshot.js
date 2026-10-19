/*
 * screenshot.js — spot-check a generated architecture.html in headless Chrome.
 *
 * Usage:
 *   1. Make sure puppeteer-core is installed:  npm i puppeteer-core
 *   2. Install Chrome or Edge, or set CHROME_PATH to its executable. Also checks:
 *        /home/claude/.cache/puppeteer/chrome/linux-*\/chrome-linux64/chrome
 *        /usr/bin/chromium
 *   3. Run:  node screenshot.js <path-to-architecture.html> [output-dir]
 *
 * It will capture:
 *   - default mode + first flow
 *   - alternate mode + first flow
 *   - alternate mode + second flow (if it exists)
 *   - default mode + a non-first flow at step 3 (to verify step animation)
 *
 * Output files: preview-A-flow1.png, preview-B-flow1.png, etc.
 *
 * If the layout looks wrong (wires crossing, nodes overlapping, panel cramped),
 * adjust node positions in the HTML and rerun.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

let puppeteer;
try { ({ default: puppeteer } = await import('puppeteer-core')); }
catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND' || !e.message.includes("'puppeteer-core'")) throw e;
  console.error("puppeteer-core not installed. Run: npm i puppeteer-core");
  process.exit(1);
}

// ── locate chromium ────────────────────────────────────────────────────────
function findChrome() {
  if (process.env.CHROME_PATH) {
    const explicit = path.resolve(process.env.CHROME_PATH);
    if (!fs.existsSync(explicit) || !fs.statSync(explicit).isFile()) {
      throw new Error('CHROME_PATH must point to an existing browser executable.');
    }
    return explicit;
  }
  const candidates = [
    ...(process.platform === 'win32'
      ? [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.LOCALAPPDATA]
        .filter(Boolean).flatMap(root => [path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')])
      : []),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ];
  const cacheDir = path.join(process.env.PUPPETEER_CACHE_DIR || path.join(homedir(), '.cache', 'puppeteer'), 'chrome');
  if (fs.existsSync(cacheDir)) {
    for (const v of fs.readdirSync(cacheDir)) {
      for (const binary of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome']) {
        candidates.push(path.join(cacheDir, v, binary));
      }
    }
  }
  return candidates.find(p => fs.existsSync(p) && fs.statSync(p).isFile());
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  const htmlPath = process.argv[2];
  if (!htmlPath) {
    console.error("Usage: node screenshot.js <path-to-architecture.html> [output-dir]");
    process.exit(1);
  }
  const outDir = process.argv[3] || path.dirname(htmlPath);
  const abs = path.resolve(htmlPath);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error("No browser found. Install Chrome or Edge, or set CHROME_PATH to its executable.");
    process.exit(1);
  }
  console.log(`Using chromium: ${chrome}`);

  const browser = await puppeteer.launch({
    executablePath: chrome,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--font-render-hinting=none']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1480, height: 920, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(abs).href, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500)); // let fonts settle

  // discover modes and flows from the DOM
  const meta = await page.evaluate(() => {
    const modes = Array.from(document.querySelectorAll('.modepick button')).map(b => b.dataset.mode);
    const flows = Array.from(document.querySelectorAll('.flowtab')).map(b => b.dataset.flow);
    return { modes, flows };
  });
  console.log("Modes:", meta.modes);
  console.log("Flows:", meta.flows);

  const captures = [];
  const captureNow = async (name) => {
    const file = path.join(outDir, `preview-${name}.png`);
    await page.screenshot({ path: file });
    captures.push(file);
    console.log(`  ✓ ${file}`);
  };

  // default mode (first) + first flow
  const defaultMode = meta.modes[0] ?? 'default';
  await captureNow(`${defaultMode}-${meta.flows[0]}`);

  // alternate mode (if exists) + first flow
  if (meta.modes.length > 1) {
    await page.click(`.modepick button[data-mode="${meta.modes[1]}"]`);
    await new Promise(r => setTimeout(r, 600));
    await captureNow(`${meta.modes[1]}-${meta.flows[0]}`);

    // alternate mode + second flow if exists
    if (meta.flows.length > 1) {
      await page.click(`.flowtab[data-flow="${meta.flows[1]}"]`);
      await new Promise(r => setTimeout(r, 400));
      await captureNow(`${meta.modes[1]}-${meta.flows[1]}`);
    }
  }

  // back to default mode, last flow if exists, advance a couple of steps
  if (meta.modes.length > 0) {
    await page.click(`.modepick button[data-mode="${meta.modes[0]}"]`);
  }
  const probeFlow = meta.flows[meta.flows.length-1];
  await page.click(`.flowtab[data-flow="${probeFlow}"]`);
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await new Promise(r => setTimeout(r, 400));
  await captureNow(`${defaultMode}-${probeFlow}-step3`);

  await browser.close();
  console.log(`\nCaptured ${captures.length} screenshot(s).`);
})().catch(e => {
  console.error("Screenshot failed:", e);
  process.exit(1);
});
