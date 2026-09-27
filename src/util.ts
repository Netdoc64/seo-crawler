export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function errMsg(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'TimeoutError') return 'Zeitüberschreitung';
  const code = (err.cause as { code?: string } | undefined)?.code;
  return code ? `${err.message} (${code})` : err.message;
}

/** Begrenzt, wie viele Aufgaben gleichzeitig laufen; ein freier Platz geht direkt an den nächsten Wartenden. */
export class Semaphore {
  #free: number;
  #waiters: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

/** Höflichkeit pro Host: höchstens `perHost` Anfragen gleichzeitig und ein Mindestabstand zwischen den Starts. */
export class HostLimiter {
  #perHost: number;
  #delayMs: number;
  #hosts = new Map<string, { slots: Semaphore; next: number; delayMs: number }>();

  constructor(perHost: number, delayMs: number) {
    this.#perHost = perHost;
    this.#delayMs = delayMs;
  }

  #get(host: string) {
    let h = this.#hosts.get(host);
    if (!h) {
      h = { slots: new Semaphore(this.#perHost), next: 0, delayMs: this.#delayMs };
      this.#hosts.set(host, h);
    }
    return h;
  }

  /** robots.txt Crawl-delay darf den Abstand nur vergrößern. */
  setDelay(host: string, ms: number) {
    const h = this.#get(host);
    h.delayMs = Math.max(h.delayMs, ms);
  }

  run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const h = this.#get(host);
    return h.slots.use(async () => {
      const now = Date.now();
      const start = Math.max(now, h.next);
      h.next = start + h.delayMs;
      if (start > now) await sleep(start - now);
      return fn();
    });
  }
}
