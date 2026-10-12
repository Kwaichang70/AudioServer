import { Router } from 'express';
import { requireOwner } from '../utils/ownership.js';
import { homeData } from '../services/home.js';

/** Home as an overview (R08.2): one request for everything that is local. */
export const homeRouter = Router();

homeRouter.get('/', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  res.json({ data: homeData(owner) });
});
