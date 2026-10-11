import { z } from 'zod';

/**
 * Field conditions (R05.3): the six-field rules smart playlists had before
 * Focus, kept as one more part of the Focus language.
 *
 * They are not a second filter system. A condition is ANDed with the rest of
 * a Focus query like any facet, and its SQL is byte for byte what the old
 * smart playlist ran — which is how a migrated smart playlist gives the same
 * tracks it gave before.
 *
 * This module is pure (no database), so the migration can use it.
 */

export const ruleFields = z.enum([
  'genre',
  'year',
  'format',
  'sampleRate',
  'bitDepth',
  'artistName',
]);
export const ruleOperators = z.enum(['equals', 'contains', 'greaterThan', 'lessThan', 'between']);
export type RuleField = z.infer<typeof ruleFields>;
export type RuleOperator = z.infer<typeof ruleOperators>;

export const allowedOperators: Record<RuleField, readonly RuleOperator[]> = {
  genre: ['equals', 'contains'],
  year: ['equals', 'greaterThan', 'lessThan', 'between'],
  format: ['equals', 'contains'],
  sampleRate: ['equals', 'greaterThan', 'lessThan'],
  bitDepth: ['equals', 'greaterThan'],
  artistName: ['equals', 'contains'],
};

const numericFields = new Set<RuleField>(['year', 'sampleRate', 'bitDepth']);

export const ruleSchema = z
  .object({
    field: ruleFields,
    operator: ruleOperators,
    value: z.string().trim().min(1),
    value2: z.string().trim().min(1).optional(),
  })
  .superRefine((rule, ctx) => {
    if (!allowedOperators[rule.field].includes(rule.operator)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operator'],
        message: `${rule.operator} is not supported for ${rule.field}`,
      });
    }
    if (numericFields.has(rule.field) && !Number.isFinite(Number(rule.value))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `${rule.field} requires a numeric value`,
      });
    }
    if (rule.operator === 'between') {
      if (rule.value2 === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value2'],
          message: 'between requires a second value',
        });
      } else if (!Number.isFinite(Number(rule.value2))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value2'],
          message: 'between requires a numeric second value',
        });
      }
    }
  });
export type Rule = z.infer<typeof ruleSchema>;
export const rulesSchema = z.array(ruleSchema);

/** Columns per field, with tracks as `t` and their album as `a`. */
const fieldColumn: Record<RuleField, string> = {
  genre: 'a.genre',
  year: 'a.year',
  format: 't.format',
  sampleRate: 't.sample_rate',
  bitDepth: 't.bit_depth',
  artistName: 't.artist_name',
};

/** One condition per rule, as the pre-Focus smart playlists built them. */
export function ruleSql(rules: Rule[]): { sql: string[]; params: Array<string | number> } {
  const sql: string[] = [];
  const params: Array<string | number> = [];
  for (const rule of rules) {
    const col = fieldColumn[rule.field];
    switch (rule.operator) {
      case 'equals':
        sql.push(`${col} = ?`);
        params.push(rule.value);
        break;
      case 'contains':
        sql.push(`${col} LIKE ?`);
        params.push(`%${rule.value}%`);
        break;
      case 'greaterThan':
        sql.push(`${col} > ?`);
        params.push(Number(rule.value));
        break;
      case 'lessThan':
        sql.push(`${col} < ?`);
        params.push(Number(rule.value));
        break;
      case 'between':
        sql.push(`${col} BETWEEN ? AND ?`);
        params.push(Number(rule.value), Number(rule.value2 || rule.value));
        break;
    }
  }
  return { sql, params };
}

/** Rules travel in a Focus URL as one JSON object per `rule` parameter. */
export function parseRuleParams(values: string[]): Rule[] | undefined {
  const rules: Rule[] = [];
  for (const value of values.slice(0, 20)) {
    try {
      const parsed = ruleSchema.safeParse(JSON.parse(value));
      if (parsed.success) rules.push(parsed.data);
    } catch {
      // An unreadable condition is dropped, like any unknown Focus value.
    }
  }
  return rules.length > 0 ? rules : undefined;
}

export const encodeRule = (rule: Rule): string =>
  JSON.stringify(
    rule.value2 === undefined
      ? { field: rule.field, operator: rule.operator, value: rule.value }
      : rule,
  );

// ─── Smart playlist definitions ─────────────────────────────────────────────

/**
 * A smart playlist is a stored Focus question (R05.3): one or more groups,
 * each a Focus query string, ORed together; a sort; a limit.
 */
export interface SmartDefinition {
  version: 2;
  groups: string[];
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
}

export const SMART_LIMIT_DEFAULT = 200;
export const SMART_LIMIT_MAX = 1000;

export const definitionSchema = z.object({
  groups: z.array(z.string().max(4000)).min(1).max(10),
  sort: z.string().max(20).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(SMART_LIMIT_MAX).optional(),
});

/**
 * The definition an old six-field smart playlist migrates to: its rules as
 * one group, sorted by artist as it always was, at its old fixed limit.
 */
export function legacyDefinition(rules: Rule[]): SmartDefinition {
  const params = new URLSearchParams();
  for (const rule of rules) params.append('rule', encodeRule(rule));
  return {
    version: 2,
    groups: [params.toString()],
    sort: 'artist',
    order: 'asc',
    limit: SMART_LIMIT_DEFAULT,
  };
}
