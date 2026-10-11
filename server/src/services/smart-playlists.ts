import {
  SMART_LIMIT_DEFAULT,
  definitionSchema,
  legacyDefinition,
  rulesSchema,
  type Rule,
  type SmartDefinition,
} from './focus-rules.js';
import {
  SORT_KEYS,
  focusTrackGroups,
  parseFocusQuery,
  serializeFocusQuery,
  type SortKey,
} from './focus.js';

/**
 * Smart playlists as stored Focus questions (R05.3).
 *
 * A definition is one or more Focus query strings — the same language as the
 * URL of a Focus page and a bookmark — ORed together, with a sort and a
 * limit. The pre-Focus six-field rules are a part of that language, so an
 * old playlist is simply one group made of its rules.
 */

/** A definition from user input, normalized: each group re-serialized by the server. */
export function normalizeDefinition(input: unknown): SmartDefinition {
  const parsed = definitionSchema.parse(input);
  const groups = parsed.groups.map((group) =>
    serializeFocusQuery(withoutSort(parseFocusQuery(Object.fromEntries(groupParams(group))))),
  );
  const sort = (SORT_KEYS as readonly string[]).includes(parsed.sort ?? '')
    ? (parsed.sort as SortKey)
    : undefined;
  return {
    version: 2,
    groups,
    sort,
    order: parsed.order,
    limit: parsed.limit ?? SMART_LIMIT_DEFAULT,
  };
}

/** A sort inside a group means nothing: the playlist has one order. */
function withoutSort<T extends { sort?: unknown; order?: unknown }>(q: T): T {
  return { ...q, sort: undefined, order: undefined };
}

/** URLSearchParams to the shape `parseFocusQuery` reads: repeated keys as arrays. */
export function groupParams(search: string): Array<[string, string[]]> {
  const map = new Map<string, string[]>();
  for (const [key, value] of new URLSearchParams(search)) {
    map.set(key, [...(map.get(key) ?? []), value]);
  }
  return [...map.entries()];
}

/**
 * The definition a stored row stands for: its own, or — for a row the
 * migration could not convert — one made from its rules now. Null when
 * neither can be read.
 */
export function definitionOf(row: {
  definition: string | null;
  rules: string;
}): SmartDefinition | null {
  if (row.definition) {
    try {
      return normalizeDefinition(JSON.parse(row.definition));
    } catch {
      return null;
    }
  }
  try {
    const rules = rulesSchema.safeParse(JSON.parse(row.rules));
    return rules.success ? legacyDefinition(rules.data) : null;
  } catch {
    return null;
  }
}

export const definitionFromRules = (rules: Rule[]): SmartDefinition => legacyDefinition(rules);

/**
 * The tracks of a definition, read with the OWNER's listening data: "never
 * played" in a shared playlist means never played by the person who made it.
 */
export function evaluateDefinition(
  definition: SmartDefinition,
  ownerId: string | null,
): { rows: Array<Record<string, unknown>>; total: number } {
  const groups = definition.groups.map((group) =>
    parseFocusQuery(Object.fromEntries(groupParams(group))),
  );
  const sort = (SORT_KEYS as readonly string[]).includes(definition.sort ?? '')
    ? (definition.sort as SortKey)
    : undefined;
  return focusTrackGroups(groups, { sort, order: definition.order }, ownerId, {
    limit: definition.limit,
    offset: 0,
  });
}
