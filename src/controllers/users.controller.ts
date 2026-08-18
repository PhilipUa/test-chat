import type { Request, Response } from 'express';
import { listUsers } from '../services/users.ts';

/** There's no auth in this app; the UI needs the demo users to offer an identity switcher. */
export async function list(_req: Request, res: Response): Promise<void> {
  res.json(await listUsers());
}
