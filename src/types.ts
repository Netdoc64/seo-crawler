export type Severity = 'error' | 'warning' | 'info';

export interface Heading {
  level: number;
  text: string;
}

export interface Link {
  href: string;
  text: string;
  rel: string;
  internal: boolean;
  nofollow: boolean;
}

export interface Image {
  src: string;
  alt: string | null;
}

export interface Hreflang {
  lang: string;
  href: string;
}

/** Was aus einem HTML-Dokument gelesen wurde – einmal roh, einmal gerendert. */
export interface Snapshot {
  status: number;
  timeMs: number;
  bytes: number;
  title: string | null;
  metaDescription: string | null;
  metaRobots: string | null;
  canonical: string | null;
  lang: string | null;
  h1: string[];
  headings: Heading[];
  hreflang: Hreflang[];
  og: Record<string, string>;
  jsonLdTypes: string[];
  jsonLdErrors: number;
  links: Link[];
  images: Image[];
  wordCount: number;
}

export interface Hop {
  url: string;
  status: number;
}

export interface PageResult {
  url: string;
  finalUrl: string;
  depth: number;
  foundOn: string | null;
  /** Nur bei Start-URLs: woher sie kamen. url schlägt file schlägt sitemap. */
  seedSource?: 'url' | 'file' | 'sitemap';
  /** Externes Link-Ziel, das nur auf Erreichbarkeit geprüft wurde (kein Inhalt, Tiefe -1). */
  external?: true;
  /** Status am Ende der Weiterleitungskette; 0 = Netzfehler. */
  status: number;
  contentType: string | null;
  headers: Record<string, string>;
  redirects: Hop[];
  robotsBlocked: boolean;
  /** Weiterleitungsziel wurde schon anderweitig gecrawlt – kein eigener Inhalt. */
  duplicateOf: string | null;
  error: string | null;
  renderError: string | null;
  raw: Snapshot | null;
  rendered: Snapshot | null;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  url: string;
  message: string;
}

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
