/**
 * BrowserController — Playwright over CDP, attaching to the Chrome that
 * already runs inside each sandbox. We don't launch a fresh browser; we
 * piggyback on the same instance that xdotool drives, so cookies/login
 * stay in one place and the human can watch via VNC.
 *
 * Set-of-Mark prompting: snapshot() injects numbered overlays on every
 * interactive element, screenshots, then strips the overlays. The AI
 * works in "ref" numbers instead of guessing pixel coordinates.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

interface ConsoleEntry {
  level: string;
  text: string;
  ts: number;
}

interface NetworkError {
  url: string;
  method: string;
  failure: string;
  ts: number;
}

interface AttachedBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  consoleLogs: ConsoleEntry[];
  networkErrors: NetworkError[];
}

const STEALTH_INIT = `
  // Smaller-than-stealth-plugin: patch the few fingerprints that matter
  // most. Full coverage requires puppeteer-extra (heavy); these 4 patches
  // get us past ~80% of bot checks. Add more here as we hit blockers.
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'vi'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
`;

// Domains we always abort: cookie consent SDKs + ad networks + analytics +
// social tracking pixels. Blocking them at the network layer means the
// scripts never inject their modal/iframe, so pages render content directly.
// 90% of "popup struggle" goes away.
const BLOCKED_HOST_RE = /(onetrust|cookiebot|cookielaw|optanon|trustarc|quantcast|consensu|usercentrics|didomi|sourcepoint|googletagmanager|google-analytics|doubleclick|googlesyndication|googleadservices|adsystem|facebook\.(com|net)\/(tr|plugins)|hotjar|mixpanel|segment\.io|fullstory|intercom)\.(com|net|io|org)/i;

// Resource types that we never need for content extraction. Aborts ~70% of
// bytes on a typical news page, with no impact on text/links/forms.
const BLOCKED_TYPES = new Set(['image', 'media']);

async function applyResourceBlocking(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const req = route.request();
    if (BLOCKED_TYPES.has(req.resourceType())) return route.abort().catch(() => {});
    if (BLOCKED_HOST_RE.test(req.url())) return route.abort().catch(() => {});
    return route.continue().catch(() => {});
  });
}

/** Run an async fn over `items` with at most `concurrency` in flight.
 *  Used by callers (e.g. batch reference verification) to fan out network
 *  work without blowing up Chromium's renderer-process limits. */
export async function runInPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        // Preserve slot ordering — caller can inspect rejections by checking type.
        out[i] = e as R;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}

// Cap on number of marked elements per snapshot. Twitter/Reddit feeds can
// surface 500+ interactive nodes — sending all of them blows token budget
// and clutters the screenshot beyond legibility.
const MAX_REFS_PER_SNAPSHOT = 150;

// Returns markers for visible interactive elements + draws numbered overlays.
// Stored in window.__taw_refs so subsequent click/type tools can resolve.
const SOM_INJECT = `
  (() => {
    const sel = 'a, button, input:not([type=hidden]), select, textarea, [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
    const all = Array.from(document.querySelectorAll(sel));
    const visible = all.filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      if (r.bottom < 0 || r.right < 0) return false;
      if (r.top > innerHeight || r.left > innerWidth) return false;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
      return true;
    });
    document.querySelectorAll('.__taw_mark').forEach(m => m.remove());
    const MAX = ${MAX_REFS_PER_SNAPSHOT};
    const refs = visible.slice(0, MAX);
    window.__taw_refs = refs;
    const out = refs.map((el, i) => {
      const r = el.getBoundingClientRect();
      const ref = i + 1;
      const mark = document.createElement('div');
      mark.className = '__taw_mark';
      mark.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;border:2px solid #f00;pointer-events:none;z-index:2147483647;box-sizing:border-box';
      const label = document.createElement('div');
      label.style.cssText = 'position:absolute;top:-16px;left:-2px;background:#f00;color:#fff;padding:0 4px;font:bold 11px monospace;line-height:14px;white-space:nowrap';
      label.textContent = String(ref);
      mark.appendChild(label);
      document.body.appendChild(mark);
      const text = (el.innerText || el.value || '').toString().trim().slice(0, 80);
      return {
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        type: el.getAttribute('type') || '',
        name: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || text,
        bbox: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      };
    });
    return { items: out, totalVisible: visible.length };
  })()
`;

const SOM_CLEAR = `document.querySelectorAll('.__taw_mark').forEach(m => m.remove())`;

export interface SnapshotElement {
  ref: number;
  tag: string;
  role: string;
  type: string;
  name: string;
  bbox: [number, number, number, number];
}

export interface SnapshotResult {
  url: string;
  title: string;
  elements: SnapshotElement[];
  /** Total visible interactive elements before MAX_REFS_PER_SNAPSHOT cap. */
  total_visible: number;
  truncated: boolean;
  screenshot: string; // base64 jpeg
  open_tabs: number;
}

export class BrowserController {
  private attached = new Map<string, AttachedBrowser>();

  /** Resolve the WebSocket debugger URL via the container's CDP bridge.
   *
   *  Chrome inside the container listens on 127.0.0.1:9222. The CDP bridge
   *  (0.0.0.0:9223 → 127.0.0.1:9222) makes it reachable from the host via
   *  the container's IP. We fetch /json/version, rewrite the advertised
   *  wsEndpoint to use the container IP, then pass it to Playwright.
   *
   *  Retries: when called right after vm_create, Chrome may still be
   *  warming up. Poll for up to ~12s before giving up. */
  private async _resolveWsEndpoint(cdpHost: string): Promise<string> {
    const cdpUrl = `http://${cdpHost}:9223/json/version`;
    let lastErr: unknown;
    for (let i = 0; i < 24; i++) {
      try {
        const res = await fetch(cdpUrl);
        if (res.ok) {
          const data = (await res.json()) as { webSocketDebuggerUrl?: string };
          if (!data.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl');
          // Replace whatever host:port Chrome advertised with container IP:9223.
          return data.webSocketDebuggerUrl.replace(
            /^ws:\/\/[^/]+\//,
            `ws://${cdpHost}:9223/`,
          );
        }
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `Chrome CDP not reachable at ${cdpUrl} after 12s. ` +
        `Last error: ${(lastErr as Error)?.message ?? 'unknown'}`,
    );
  }

  /** Connect (or reuse) a CDP session for the given sandbox. */
  private async attach(sandboxId: string, cdpHost: string): Promise<AttachedBrowser> {
    const cached = this.attached.get(sandboxId);
    if (cached) {
      // Validate page is still alive — Chrome may have been closed/restarted.
      try {
        await cached.page.evaluate('1');
        // Auto-close stale tabs: keep only the active page
        await this._cleanupTabs(cached);
        return cached;
      } catch {
        this.attached.delete(sandboxId);
      }
    }
    const wsEndpoint = await this._resolveWsEndpoint(cdpHost);
    const browser = await chromium.connectOverCDP(wsEndpoint);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    await context.addInitScript(STEALTH_INIT);
    // Network-level resource blocking: applies to every page in this context,
    // current and future. Aborts images/media + cookie SDKs + ad/tracker
    // domains so the popups never get a chance to render.
    // Note: fonts are NOT blocked — Playwright waits for fonts before screenshot.
    await applyResourceBlocking(context);
    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    const consoleLogs: ConsoleEntry[] = [];
    const networkErrors: NetworkError[] = [];

    // Capture console logs (errors, warnings, info)
    page.on('console', (msg) => {
      consoleLogs.push({ level: msg.type(), text: msg.text().slice(0, 500), ts: Date.now() });
      if (consoleLogs.length > 200) consoleLogs.shift(); // ring buffer
    });

    // Capture network failures
    page.on('requestfailed', (req) => {
      networkErrors.push({
        url: req.url().slice(0, 300),
        method: req.method(),
        failure: req.failure()?.errorText ?? 'unknown',
        ts: Date.now(),
      });
      if (networkErrors.length > 100) networkErrors.shift();
    });

    const entry = { browser, context, page, consoleLogs, networkErrors };
    this.attached.set(sandboxId, entry);
    // If Chrome closes, drop the cache so next call re-attaches.
    browser.on('disconnected', () => this.attached.delete(sandboxId));
    // Clean up any pre-existing tabs from before we attached
    await this._cleanupTabs(entry);
    return entry;
  }

  /** Close all tabs except the active page. Returns number of tabs closed. */
  private async _cleanupTabs(entry: AttachedBrowser): Promise<number> {
    const MAX_TABS = 3;
    const pages = entry.context.pages();
    if (pages.length <= MAX_TABS) return 0;
    let closed = 0;
    for (const p of pages) {
      if (p === entry.page) continue;
      try { await p.close(); closed++; } catch {}
    }
    if (closed > 0) {
      console.error(`Tab cleanup: closed ${closed} stale tab(s), kept active page`);
    }
    return closed;
  }

  async detach(sandboxId: string): Promise<void> {
    const entry = this.attached.get(sandboxId);
    if (!entry) return;
    this.attached.delete(sandboxId);
    try {
      await entry.browser.close();
    } catch {}
  }

  async navigate(sandboxId: string, cdpHost: string, url: string): Promise<{ url: string; title: string; open_tabs: number }> {
    const { page, context } = await this.attach(sandboxId, cdpHost);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Quiet the network for a beat so dynamic content paints before snapshot.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    // Bring the CDP-controlled page to front so desktop/VNC shows the same
    // content as CDP. Without this, desktop_screenshot can show a stale tab.
    await page.bringToFront().catch(() => {});
    return { url: page.url(), title: await page.title(), open_tabs: context.pages().length };
  }

  async snapshot(sandboxId: string, cdpHost: string): Promise<SnapshotResult> {
    const { page, context } = await this.attach(sandboxId, cdpHost);
    const result = (await page.evaluate(SOM_INJECT)) as {
      items: SnapshotElement[];
      totalVisible: number;
    };
    // Disable font wait to prevent timeout when Google Fonts are slow in containers
    const buf = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false, timeout: 10000 })
      .catch(() => page.screenshot({ type: 'jpeg', quality: 50, fullPage: false, animations: 'disabled', timeout: 5000 }));
    await page.evaluate(SOM_CLEAR).catch(() => {});
    return {
      url: page.url(),
      title: await page.title(),
      elements: result.items,
      total_visible: result.totalVisible,
      truncated: result.totalVisible > result.items.length,
      screenshot: buf.toString('base64'),
      open_tabs: context.pages().length,
    };
  }

  /** Click an element by its snapshot ref number. Falls back to mouse click
   *  at the element's center so framework event handlers fire correctly
   *  (some React/Vue components ignore raw .click()). */
  async clickRef(sandboxId: string, cdpHost: string, ref: number): Promise<string> {
    const { page } = await this.attach(sandboxId, cdpHost);
    const center = (await page.evaluate(`(() => {
      const el = (window.__taw_refs || [])[${ref - 1}];
      if (!el) return null;
      el.scrollIntoView({block: 'center', inline: 'center'});
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    })()`)) as [number, number] | null;
    if (!center) throw new Error(`ref ${ref} not in current snapshot — call browser_snapshot first`);
    await page.mouse.click(center[0], center[1]);
    return `clicked ref ${ref}`;
  }

  async typeRef(sandboxId: string, cdpHost: string, ref: number, value: string, submit = false): Promise<string> {
    const { page } = await this.attach(sandboxId, cdpHost);
    const ok = (await page.evaluate(`(() => {
      const el = (window.__taw_refs || [])[${ref - 1}];
      if (!el) return false;
      el.focus();
      if ('value' in el) el.value = '';
      return true;
    })()`)) as boolean;
    if (!ok) throw new Error(`ref ${ref} not in current snapshot — call browser_snapshot first`);
    await page.keyboard.type(value, { delay: 8 });
    if (submit) await page.keyboard.press('Enter');
    return `typed into ref ${ref}${submit ? ' + Enter' : ''}`;
  }

  async extract(sandboxId: string, cdpHost: string, selector?: string): Promise<string> {
    const { page } = await this.attach(sandboxId, cdpHost);
    const raw = !selector
      ? ((await page.evaluate('document.body.innerText')) as string)
      : ((await page.evaluate(`(() => {
          const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
          return els.map(e => (e.innerText || e.textContent || '').trim()).filter(Boolean).join('\\n---\\n');
        })()`)) as string);
    // Long pages (Wikipedia, Reddit threads, blog posts) can return 200KB+
    // of text. Cap to keep token cost predictable; AI can request a more
    // specific selector if it needs the rest.
    const MAX = 50_000;
    if (raw.length <= MAX) return raw;
    return `${raw.slice(0, MAX)}\n…[truncated: ${raw.length - MAX} more chars — pass a more specific selector to narrow down]`;
  }

  async evaluate(sandboxId: string, cdpHost: string, expression: string): Promise<unknown> {
    const { page } = await this.attach(sandboxId, cdpHost);
    return await page.evaluate(expression);
  }

  async waitFor(
    sandboxId: string,
    cdpHost: string,
    condition: { selector?: string; text?: string; networkidle?: boolean; timeout?: number },
  ): Promise<string> {
    const { page } = await this.attach(sandboxId, cdpHost);
    const timeout = condition.timeout ?? 15000;
    if (condition.selector) {
      await page.waitForSelector(condition.selector, { timeout });
      return `selector ready: ${condition.selector}`;
    }
    if (condition.text) {
      // String form: TS doesn't have to know about `document` here.
      await page.waitForFunction(
        `document.body && document.body.innerText.includes(${JSON.stringify(condition.text)})`,
        undefined,
        { timeout },
      );
      return `text appeared: ${condition.text}`;
    }
    if (condition.networkidle) {
      await page.waitForLoadState('networkidle', { timeout });
      return 'networkidle';
    }
    await page.waitForTimeout(Math.min(timeout, 1000));
    return 'waited';
  }

  /** Return captured console logs (errors, warnings, etc.) and optionally clear them. */
  async consoleLogs(
    sandboxId: string,
    cdpHost: string,
    opts?: { level?: string; clear?: boolean },
  ): Promise<ConsoleEntry[]> {
    const entry = await this.attach(sandboxId, cdpHost);
    let logs = [...entry.consoleLogs];
    if (opts?.level) logs = logs.filter((l) => l.level === opts.level);
    if (opts?.clear) entry.consoleLogs.length = 0;
    return logs;
  }

  /** Return captured network errors (failed requests) and optionally clear them. */
  async networkErrors(
    sandboxId: string,
    cdpHost: string,
    opts?: { clear?: boolean },
  ): Promise<NetworkError[]> {
    const entry = await this.attach(sandboxId, cdpHost);
    const errors = [...entry.networkErrors];
    if (opts?.clear) entry.networkErrors.length = 0;
    return errors;
  }

  /**
   * Run a Playwright test script against the browser inside a sandbox.
   * The script receives `{ page, browser, context, chromium }` and should
   * return a JSON-serialisable result. Console logs and network errors are
   * captured automatically. Eliminates the need for AI to install Playwright
   * separately — the host already has playwright-core.
   */
  async runTest(
    sandboxId: string,
    cdpHost: string,
    script: string,
    opts?: { timeout?: number },
  ): Promise<{ ok: boolean; result?: unknown; error?: string; consoleLogs: ConsoleEntry[]; networkErrors: NetworkError[] }> {
    const timeout = opts?.timeout ?? 120000;
    const consoleLogs: ConsoleEntry[] = [];
    const networkErrors: NetworkError[] = [];

    let browser: Browser | null = null;
    try {
      const wsEndpoint = await this._resolveWsEndpoint(cdpHost);
      browser = await chromium.connectOverCDP(wsEndpoint);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());

      // Capture console & network
      page.on('console', (msg) => {
        consoleLogs.push({ level: msg.type(), text: msg.text().slice(0, 500), ts: Date.now() });
      });
      page.on('requestfailed', (req) => {
        networkErrors.push({
          url: req.url().slice(0, 300),
          method: req.method(),
          failure: req.failure()?.errorText ?? 'unknown',
          ts: Date.now(),
        });
      });

      // Build an async function from the script and execute it
      const fn = new Function(
        'page', 'browser', 'context', 'chromium',
        `return (async () => { ${script} })();`,
      );

      const result = await Promise.race([
        fn(page, browser, context, chromium),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Test timed out after ${timeout}ms`)), timeout),
        ),
      ]);

      return { ok: true, result: result ?? null, consoleLogs, networkErrors };
    } catch (e) {
      return { ok: false, error: (e as Error).message, consoleLogs, networkErrors };
    } finally {
      // Close test browser connection but don't kill Chrome in the container
      if (browser) await browser.close().catch(() => {});
    }
  }

  /** Devin-style ergonomic shortcut: navigate google → extract top results. */
  async webSearch(
    sandboxId: string,
    cdpHost: string,
    query: string,
  ): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const { page } = await this.attach(sandboxId, cdpHost);
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    return (await page.evaluate(`(() => {
      const out = [];
      // Google result blocks: each has an <h3> inside an <a>. Skip ads/sitelinks.
      const blocks = Array.from(document.querySelectorAll('div.g, div[data-hveid]'));
      const seen = new Set();
      for (const b of blocks) {
        const h3 = b.querySelector('h3');
        const a = h3 && h3.closest('a');
        if (!h3 || !a) continue;
        const href = a.href;
        if (!href || seen.has(href)) continue;
        seen.add(href);
        // Snippet: first reasonable text node under the block, not the title.
        let snippet = '';
        const cand = b.querySelector('div[data-sncf], div[role="text"], span.st, .VwiC3b');
        if (cand) snippet = (cand.innerText || '').trim().slice(0, 240);
        out.push({ title: h3.innerText.trim(), url: href, snippet });
        if (out.length >= 8) break;
      }
      return out;
    })()`)) as Array<{ title: string; url: string; snippet: string }>;
  }
}
