import { chromium, errors, type Browser, type BrowserContext } from 'playwright';

export interface RenderOptions {
  userAgent: string;
  timeoutMs: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
  blockResources: string[];
}

export interface RenderResult {
  html: string;
  status: number;
  timeMs: number;
  timedOut: boolean;
}

/** Ein Chromium für den ganzen Lauf; jede Seite bekommt ihren eigenen Tab. */
export class Renderer {
  #opts: RenderOptions;
  #session: Promise<{ browser: Browser; context: BrowserContext }> | null = null;

  constructor(opts: RenderOptions) {
    this.#opts = opts;
  }

  start() {
    this.#session ??= (async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext({ userAgent: this.#opts.userAgent });
      const blocked = new Set(this.#opts.blockResources);
      if (blocked.size) {
        await context.route('**/*', (route) =>
          blocked.has(route.request().resourceType()) ? route.abort() : route.continue(),
        );
      }
      return { browser, context };
    })();
    return this.#session;
  }

  async render(url: string): Promise<RenderResult> {
    const { context } = await this.start();
    const page = await context.newPage();
    const started = performance.now();
    try {
      let status = 0;
      let timedOut = false;
      try {
        const res = await page.goto(url, { waitUntil: this.#opts.waitUntil, timeout: this.#opts.timeoutMs });
        status = res?.status() ?? 0;
      } catch (err) {
        // networkidle kommt auf Seiten mit Dauer-Polling nie – dann zählt, was bis dahin da ist.
        if (!(err instanceof errors.TimeoutError)) throw err;
        timedOut = true;
      }
      return { html: await page.content(), status, timeMs: Math.round(performance.now() - started), timedOut };
    } finally {
      await page.close();
    }
  }

  async close() {
    if (!this.#session) return;
    const session = await this.#session.catch(() => null);
    await session?.browser.close();
  }
}
