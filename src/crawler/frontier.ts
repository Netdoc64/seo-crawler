export interface QueueItem {
  url: string;
  depth: number;
  foundOn: string | null;
}

/** Warteschlange mit Duplikatschutz; `next()` liefert null, sobald nichts mehr kommt und niemand mehr arbeitet. */
export class Frontier {
  #items: QueueItem[] = [];
  #head = 0;
  #seen = new Set<string>();
  #accepted = 0;
  #limit: number;
  #active = 0;
  #waiters: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  get pending(): number {
    return this.#items.length - this.#head;
  }

  /** `force` umgeht das Seitenlimit – für Start-URLs, die ausdrücklich gescannt werden sollen. */
  add(item: QueueItem, force = false): boolean {
    if (this.#seen.has(item.url)) return false;
    if (!force && this.#accepted >= this.#limit) return false;
    this.#seen.add(item.url);
    this.#accepted++;
    this.#items.push(item);
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
      if (this.#head < this.#items.length) {
        const item = this.#items[this.#head++]!;
        if (this.#head > 4096 && this.#head * 2 > this.#items.length) {
          this.#items = this.#items.slice(this.#head);
          this.#head = 0;
        }
        this.#active++;
        return item;
      }
      if (this.#active === 0) {
        this.#wake();
        return null;
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  done(): void {
    this.#active--;
    this.#wake();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}
