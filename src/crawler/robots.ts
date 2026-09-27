import robotsParserModule from 'robots-parser';
import { fetchPage } from './fetcher.ts';

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
}

// Die mitgelieferten Typen behaupten einen ESM-default-Export; das Paket ist CommonJS
// (module.exports = function), der Default-Import ist zur Laufzeit also die Funktion selbst.
const robotsParser = robotsParserModule as unknown as (url: string, robotstxt: string) => Robot;

/** Eine robots.txt pro Origin, einmal geladen. */
export class RobotsCache {
  #userAgent: string;
  #timeoutMs: number;
  #byOrigin = new Map<string, Promise<Robot | null>>();

  constructor(userAgent: string, timeoutMs: number) {
    this.#userAgent = userAgent;
    this.#timeoutMs = timeoutMs;
  }

  #load(origin: string): Promise<Robot | null> {
    let robot = this.#byOrigin.get(origin);
    if (!robot) {
      robot = (async () => {
        const robotsUrl = `${origin}/robots.txt`;
        const res = await fetchPage(robotsUrl, {
          userAgent: this.#userAgent,
          timeoutMs: this.#timeoutMs,
          accept: 'text/plain,*/*;q=0.8',
        });
        // Nur eine erreichbare robots.txt schränkt ein. 4xx, 5xx und Netzfehler heißen hier „alles erlaubt“ –
        // bewusst nachsichtiger als Google, damit ein wackliger Server nicht den ganzen Audit leer laufen lässt.
        if (res.status >= 200 && res.status < 300 && res.body !== null) return robotsParser(robotsUrl, res.body);
        return null;
      })();
      this.#byOrigin.set(origin, robot);
    }
    return robot;
  }

  async isAllowed(url: string): Promise<boolean> {
    const robot = await this.#load(new URL(url).origin);
    return robot ? robot.isAllowed(url, this.#userAgent) !== false : true;
  }

  async crawlDelayMs(url: string): Promise<number> {
    const robot = await this.#load(new URL(url).origin);
    const seconds = robot?.getCrawlDelay(this.#userAgent);
    return seconds ? seconds * 1000 : 0;
  }
}
