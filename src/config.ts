import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const SeveritySchema = z.enum(['error', 'warning', 'info']);

const DEFAULT_UA = 'Mozilla/5.0 (compatible; seo-crawler/0.1; +https://github.com/Netdoc64/seo-crawler)';

export const ConfigSchema = z
  .object({
    name: z.string().default('crawl'),
    start: z
      .object({
        urls: z.array(z.string()).default([]),
        sitemaps: z.array(z.string()).default([]),
        urlFile: z.string().optional(),
      })
      .strict()
      .prefault({}),
    scope: z
      .object({
        /** Leer = Hosts der Start-URLs. */
        hosts: z.array(z.string()).default([]),
        include: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
        maxDepth: z.number().int().min(0).default(3),
        /** Gilt für gefundene Links; Start-URLs werden immer gescannt. */
        maxPages: z.number().int().min(1).default(1000),
        followLinks: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    render: z
      .object({
        /** raw = nie rendern, render = immer, auto = nur wenn das rohe HTML nach JS-App aussieht. */
        mode: z.enum(['raw', 'render', 'auto']).default('auto'),
        concurrency: z.number().int().min(1).default(2),
        timeoutMs: z.number().int().min(1000).default(30000),
        waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('networkidle'),
        blockResources: z.array(z.string()).default(['image', 'media', 'font']),
      })
      .strict()
      .prefault({}),
    politeness: z
      .object({
        concurrency: z.number().int().min(1).default(4),
        perHost: z.number().int().min(1).default(2),
        delayMs: z.number().int().min(0).default(250),
        respectRobots: z.boolean().default(true),
        timeoutMs: z.number().int().min(1000).default(20000),
        userAgent: z.string().default(DEFAULT_UA),
      })
      .strict()
      .prefault({}),
    rules: z.array(z.string()).default(['builtin:default']),
    ruleOverrides: z
      .record(z.string(), z.object({ severity: SeveritySchema.optional(), enabled: z.boolean().optional() }).strict())
      .default({}),
    plugins: z.array(z.string()).default([]),
    output: z
      .object({ db: z.string().default('runs/seo-crawler.sqlite') })
      .strict()
      .prefault({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema> & {
  /** Verzeichnis, gegen das relative Pfade (Regeln, Plugins, urlFile) aufgelöst werden. */
  baseDir: string;
};

export interface CliOverrides {
  urls?: string[];
  sitemaps?: string[];
  urlFile?: string;
  mode?: string;
  maxPages?: number;
  maxDepth?: number;
  noFollow?: boolean;
  db?: string;
}

export function formatIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `  - ${i.path.map(String).join('.') || '(Wurzel)'}: ${i.message}`).join('\n');
}

export function parseConfig(raw: unknown, baseDir: string): Config {
  const parsed = ConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`Konfiguration ungültig:\n${formatIssues(parsed.error.issues)}`);
  const config: Config = { ...parsed.data, baseDir };
  if (config.start.urlFile) config.start.urlFile = path.resolve(baseDir, config.start.urlFile);
  config.output.db = path.resolve(baseDir, config.output.db);
  return config;
}

export async function loadConfig(file: string | undefined, cli: CliOverrides = {}): Promise<Config> {
  let raw: Record<string, any> = {};
  let baseDir = process.cwd();
  if (file) {
    raw = (parseYaml(await readFile(file, 'utf8')) as Record<string, any> | null) ?? {};
    baseDir = path.dirname(path.resolve(file));
  }
  raw.start ??= {};
  raw.scope ??= {};
  raw.render ??= {};
  if (cli.urls?.length) raw.start.urls = [...(raw.start.urls ?? []), ...cli.urls];
  if (cli.sitemaps?.length) raw.start.sitemaps = [...(raw.start.sitemaps ?? []), ...cli.sitemaps];
  if (cli.urlFile) raw.start.urlFile = path.resolve(cli.urlFile);
  if (cli.mode) raw.render.mode = cli.mode;
  if (cli.maxPages !== undefined) raw.scope.maxPages = cli.maxPages;
  if (cli.maxDepth !== undefined) raw.scope.maxDepth = cli.maxDepth;
  if (cli.noFollow) raw.scope.followLinks = false;

  const config = parseConfig(raw, baseDir);
  // --db bezieht sich wie jeder CLI-Pfad auf das aktuelle Verzeichnis, nicht auf die Config-Datei.
  if (cli.db) config.output.db = path.resolve(cli.db);
  return config;
}
