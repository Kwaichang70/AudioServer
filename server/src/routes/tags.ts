import { Router, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../utils/validate.js';
import { requireOwner } from '../utils/ownership.js';
import {
  TAG_ITEM_TYPES,
  TagNameTakenError,
  UnknownTagItemError,
  addTagItem,
  createTag,
  deleteTag,
  findTag,
  listTags,
  removeTagItem,
  tagItems,
  tagTracks,
  tagsOn,
  updateTag,
  type TagItemType,
} from '../services/tags.js';

/**
 * Tags (R06.1). Yours to edit; a shared one readable by the household; any
 * other tag is a 404, exactly like one that does not exist (V09).
 */
export const tagsRouter = Router();

const name = z.string().trim().min(1).max(80);
const createSchema = z.object({ name, shared: z.boolean().optional() });
const updateSchema = z.object({ name: name.optional(), shared: z.boolean().optional() });
const itemSchema = z.object({
  itemType: z.enum(TAG_ITEM_TYPES),
  itemId: z.string().min(1).max(256),
});

const notFound = (res: Response) => res.status(404).json({ error: 'Tag not found' });

function handle(res: Response, err: unknown): void {
  if (err instanceof TagNameTakenError) {
    res.status(409).json({ error: 'TagNameTaken', message: err.message });
    return;
  }
  if (err instanceof UnknownTagItemError) {
    res.status(404).json({ error: 'UnknownItem', message: err.message });
    return;
  }
  throw err;
}

tagsRouter.get('/', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  res.json({ data: listTags(owner) });
});

tagsRouter.post('/', validate({ body: createSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const body = req.body as z.infer<typeof createSchema>;
  try {
    res.status(201).json({ data: createTag(owner, body.name, body.shared) });
  } catch (err) {
    handle(res, err);
  }
});

// The tags you can see on one item: chips on an album page, ticks in a menu.
tagsRouter.get('/on/:itemType/:itemId', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const type = z.enum(TAG_ITEM_TYPES).safeParse(req.params.itemType);
  if (!type.success) return res.status(400).json({ error: 'Unknown item type' });
  res.json({ data: tagsOn(type.data, String(req.params.itemId), owner) });
});

tagsRouter.get('/:id', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const tag = findTag(String(req.params.id), owner, 'read');
  if (!tag) return notFound(res);
  res.json({ data: { ...tag, items: tagItems(tag.id, owner) } });
});

// Every playable track the tag stands for — its tracks, albums and artists.
tagsRouter.get('/:id/tracks', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const tag = findTag(String(req.params.id), owner, 'read');
  if (!tag) return notFound(res);
  res.json({ data: tagTracks(tag.id) });
});

tagsRouter.patch('/:id', validate({ body: updateSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  try {
    const tag = updateTag(String(req.params.id), owner, req.body as z.infer<typeof updateSchema>);
    if (!tag) return notFound(res);
    res.json({ data: tag });
  } catch (err) {
    handle(res, err);
  }
});

tagsRouter.delete('/:id', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  if (!deleteTag(String(req.params.id), owner)) return notFound(res);
  res.json({ data: { ok: true } });
});

tagsRouter.post('/:id/items', validate({ body: itemSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const { itemType, itemId } = req.body as z.infer<typeof itemSchema>;
  try {
    const tag = addTagItem(String(req.params.id), owner, itemType, itemId);
    if (!tag) return notFound(res);
    res.status(201).json({ data: tag });
  } catch (err) {
    handle(res, err);
  }
});

tagsRouter.delete('/:id/items/:itemType/:itemId', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const type = z.enum(TAG_ITEM_TYPES).safeParse(req.params.itemType);
  if (!type.success) return res.status(400).json({ error: 'Unknown item type' });
  const tag = removeTagItem(
    String(req.params.id),
    owner,
    type.data as TagItemType,
    String(req.params.itemId),
  );
  if (!tag) return notFound(res);
  res.json({ data: tag });
});
