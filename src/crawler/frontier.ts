export interface QueueItem {
  url: string;
  depth: number;
  foundOn: string | null;
  /** Nur bei Start-URLs: woher sie kamen. */
  seedSource?: 'url' | 'file' | 'sitemap';
}

/** Höflichkeitsstand je Host, wie ihn der `HostLimiter` führt (Crawl-delay kommt erst mit der robots.txt). */
export interface HostPacing {
  perHost: number;
  delayMs(host: string): number;
  nextStart(host: string): number;
}

interface HostQueue {
  items: QueueItem[];
  head: number;
  /** Ausgegeben, aber noch nicht mit `done()` zurückgemeldet. */
  active: number;
  lastStart: number;
}

const hostOf = (url: string) => new URL(url).host;

/**
 * So viel früher als der Mindestabstand erlaubt, darf eine URL ausgegeben werden. Das letzte Stück wartet der
 * `HostLimiter`, der vom geplanten statt vom tatsächlichen Start aus rechnet – ein verspäteter Timer
 * (unter Windows einige ms) verschiebt so nicht jeden folgenden Abruf.
 */
export const START_LEAD_MS = 50;

/**
 * Warteschlange mit Duplikatschutz; `next()` liefert null, sobald nichts mehr kommt und niemand mehr arbeitet.
 * Je Host eine eigene Schlange (Breitensuche), ausgegeben wird reihum von einem Host, der gerade frei ist –
 * so blockiert ein langsamer Host im Bulk-Modus nicht alle Worker.
 */
export class Frontier {
  #hosts = new Map<string, HostQueue>();
  /** Hosts mit wartenden URLs, in Reihum-Reihenfolge. */
  #ring: string[] = [];
  #cursor = 0;
  #pending = 0;
  #seen = new Set<string>();
  #accepted = 0;
  #limit: number;
  #pacing: HostPacing | null;
  #active = 0;
  #released = new WeakSet<QueueItem>();
  #waiters: (() => void)[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerAt = Infinity;

  constructor(limit: number, pacing: HostPacing | null = null) {
    this.#limit = limit;
    this.#pacing = pacing;
  }

  get pending(): number {
    return this.#pending;
  }

  /** `force` umgeht das Seitenlimit – für Start-URLs, die ausdrücklich gescannt werden sollen. */
  add(item: QueueItem, force = false): boolean {
    if (this.#seen.has(item.url)) return false;
    if (!force && this.#accepted >= this.#limit) return false;
    this.#seen.add(item.url);
    this.#accepted++;
    const host = hostOf(item.url);
    let q = this.#hosts.get(host);
    if (!q) {
      q = { items: [], head: 0, active: 0, lastStart: -Infinity };
      this.#hosts.set(host, q);
    }
    if (q.head === q.items.length) this.#ring.push(host);
    q.items.push(item);
    this.#pending++;
    this.#wake();
    return true;
  }

  /** Markiert eine URL als erledigt (z. B. ein Weiterleitungsziel). false = war schon bekannt. */
  claim(url: string): boolean {
    if (this.#seen.has(url)) return false;
    this.#seen.add(url);
    return true;
  }

  async next(): Promise<QueueItem | null> {
    for (;;) {
      let wakeAt = Infinity;
      if (this.#pending > 0) {
        const now = Date.now();
        // Erste Wahl: reihum ein Host, der jetzt frei ist. Sonst der mit dem frühesten Termin, falls der
        // höchstens START_LEAD_MS entfernt ist – den Rest wartet der Limiter.
        let soonest = -1;
        let soonestAt = Infinity;
        for (let i = 0; i < this.#ring.length; i++) {
          const idx = (this.#cursor + i) % this.#ring.length;
          const host = this.#ring[idx]!;
          const readyAt = this.#readyAt(host, this.#hosts.get(host)!);
          if (readyAt <= now) return this.#take(idx, now);
          if (readyAt < soonestAt) {
            soonest = idx;
            soonestAt = readyAt;
          }
        }
        if (soonestAt <= now + START_LEAD_MS) return this.#take(soonest, soonestAt);
        // Voller Host wird von release()/done() geweckt, einer im Mindestabstand vom Timer.
        wakeAt = soonestAt - START_LEAD_MS;
      } else if (this.#active === 0) {
        // Ein noch gestellter Timer (z. B. langes Crawl-delay) hielte sonst den Prozess am Leben.
        this.#stopTimer();
        this.#wake();
        return null;
      }
      await this.#wait(wakeAt);
    }
  }

  /**
   * Der Abruf ist durch, der Host-Platz wird frei – Auswerten und Links einreihen blockieren den Host nicht.
   * Optional: `done()` gibt einen noch belegten Platz selbst frei.
   */
  release(item: QueueItem): void {
    if (this.#released.has(item)) return;
    this.#released.add(item);
    const q = this.#hosts.get(hostOf(item.url));
    if (q) q.active--;
    this.#wake();
  }

  done(item: QueueItem): void {
    this.release(item);
    this.#active--;
    this.#wake();
  }

  #readyAt(host: string, q: HostQueue): number {
    const p = this.#pacing;
    if (!p) return 0;
    if (q.active >= p.perHost) return Infinity;
    // Delay live lesen: ein Crawl-delay aus der robots.txt wird erst nach dem ersten Abruf bekannt.
    return Math.max(q.lastStart + p.delayMs(host), p.nextStart(host));
  }

  /** `start` ist der geplante Start – bei Vorab-Ausgabe in der Zukunft, damit sich Timer-Verspätungen nicht aufsummieren. */
  #take(idx: number, start: number): QueueItem {
    const host = this.#ring[idx]!;
    const q = this.#hosts.get(host)!;
    const item = q.items[q.head++]!;
    q.active++;
    q.lastStart = start;
    this.#active++;
    this.#pending--;
    if (q.head === q.items.length) {
      q.items = [];
      q.head = 0;
      this.#ring.splice(idx, 1);
      this.#cursor = idx;
    } else {
      if (q.head > 4096 && q.head * 2 > q.items.length) {
        q.items = q.items.slice(q.head);
        q.head = 0;
      }
      this.#cursor = idx + 1;
    }
    if (this.#cursor >= this.#ring.length) this.#cursor = 0;
    return item;
  }

  /** Ein gemeinsamer Timer für den frühesten Zeitpunkt; er bleibt beim Wecken stehen, statt ständig neu gestellt zu werden. */
  #wait(until: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
      if (until < this.#timerAt) {
        this.#stopTimer();
        this.#timerAt = until;
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          this.#timerAt = Infinity;
          this.#wake();
        }, Math.max(0, until - Date.now()));
      }
    });
  }

  #stopTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerAt = Infinity;
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}
