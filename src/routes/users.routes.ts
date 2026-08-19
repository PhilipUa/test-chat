import { Router } from 'express';
import * as users from '../controllers/users.controller.ts';
import { asyncHandler } from '../middleware/async-handler.ts';

export const usersRouter = Router();

usersRouter.get('/', asyncHandler(users.list));
