// Shared headless Chromium singleton used by every scraper. Launching
// once and reusing contexts is dramatically faster than launching per
// page; the OS overhead of a new chromium process dwarfs the actual
// page render.

import { chromium, type Browser, type BrowserContext } from "playwright";

const PAGE_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; LayerSyncBot/1.0; +https://layersync.ai/bot)";

let browserSingleton: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browserSingleton && browserSingleton.isConnected()) return browserSingleton;
  browserSingleton = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  return browserSingleton;
}

export async function closeBrowser(): Promise<void> {
  if (browserSingleton) {
    await browserSingleton.close().catch(() => {});
    browserSingleton = null;
  }
}

export async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
  ctx.setDefaultTimeout(PAGE_TIMEOUT_MS);
  ctx.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
  return ctx;
}

export const SCRAPER_TIMEOUT_MS = PAGE_TIMEOUT_MS;
