import express from 'express';
import { asyncHandler } from '../http/errors.ts';
import { listUsers } from '../services/users.ts';

export const usersRouter = express.Router();

/** There's no auth in this app; the UI needs the demo users to offer an identity switcher. */
usersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await listUsers());
  }),
);
