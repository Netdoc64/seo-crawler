import { z } from 'zod';
import { SeveritySchema } from '../config.ts';
import type { PageResult, Severity } from '../types.ts';

export interface Range {
  min?: number;
  max?: number;
}

/** Eine Prüfung auf ein Feld. Mehrere Operatoren in einer Prüfung müssen alle erfüllt sein. */
export interface Check {
  field?: string;
  exists?: boolean;
  length?: Range;
  range?: Range;
  equals?: unknown;
  notEquals?: unknown;
  matches?: string;
  notMatches?: string;
  oneOf?: unknown[];
  contains?: string;
  sameHost?: boolean;
  stableAcrossRender?: boolean;
  all?: Check[];
  any?: Check[];
  not?: Check;
}

const RangeSchema = z
  .object({ min: z.number().optional(), max: z.number().optional() })
  .strict()
  .refine((r) => r.min !== undefined || r.max !== undefined, 'min oder max angeben');

export const CheckSchema: z.ZodType<Check> = z.lazy(() =>
  z
    .object({
      field: z.string().optional(),
      exists: z.boolean().optional(),
      length: RangeSchema.optional(),
      range: RangeSchema.optional(),
      equals: z.unknown().optional(),
      notEquals: z.unknown().optional(),
      matches: z.string().optional(),
      notMatches: z.string().optional(),
      oneOf: z.array(z.unknown()).optional(),
      contains: z.string().optional(),
      sameHost: z.boolean().optional(),
      stableAcrossRender: z.boolean().optional(),
      all: z.array(CheckSchema).optional(),
      any: z.array(CheckSchema).optional(),
      not: CheckSchema.optional(),
    })
    .strict(),
);

export const AppliesSchema = z
  .object({
    /** Pfad-Globs, z. B. /produkte/** */
    path: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    /** Standard: nur 200–299. */
    status: RangeSchema.optional(),
    /** Standard: true = nur HTML-Seiten mit Inhalt. false = auch PDFs, Bilder, Fehlerseiten ohne Inhalt. */
    html: z.boolean().optional(),
    indexable: z.boolean().optional(),
  })
  .strict();

const base = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'nur a–z, 0–9 und Bindestrich'),
  description: z.string().optional(),
  severity: SeveritySchema.default('warning'),
  applies: AppliesSchema.optional(),
  message: z.string().optional(),
  enabled: z.boolean().default(true),
};

export const PageRuleSchema = z
  .object({
    ...base,
    scope: z.literal('page').default('page'),
    /** effective = gerendert, falls vorhanden, sonst roh. */
    source: z.enum(['effective', 'raw', 'rendered']).default('effective'),
    when: CheckSchema.optional(),
    check: CheckSchema,
  })
  .strict();

export const SiteCheckSchema = z.union([
  z.object({ unique: z.string() }).strict(),
  z.object({ brokenLinks: z.literal('internal') }).strict(),
  z.object({ redirectingLinks: z.literal('internal') }).strict(),
  z.object({ canonicalTarget: z.literal('ok') }).strict(),
  // valid = volle Prüfung; x-default = nur der Hinweis, dass x-default fehlt (eigene Regel, separat abschaltbar).
  z.object({ hreflang: z.enum(['valid', 'x-default']) }).strict(),
]);

export const SiteRuleSchema = z
  .object({
    ...base,
    scope: z.literal('site'),
    check: SiteCheckSchema,
  })
  .strict();

export type Applies = z.infer<typeof AppliesSchema>;
export type PageRule = z.infer<typeof PageRuleSchema>;
export type SiteRule = z.infer<typeof SiteRuleSchema>;

export type Fields = Record<string, unknown>;

/** Eigene Tests als TS-Modul (`export default { … }`), wenn eine YAML-Regel nicht reicht. */
export interface Plugin {
  id: string;
  severity?: Severity;
  description?: string;
  /** Rückgabe: Befundtext(e) oder nichts, wenn die Seite in Ordnung ist. */
  checkPage?(page: PageResult, fields: Fields): string | string[] | null | undefined | void;
  checkSite?(pages: PageResult[]): { url: string; message: string }[];
}

export interface RuleSet {
  page: PageRule[];
  site: SiteRule[];
  plugins: Plugin[];
}
