import { Router } from 'express';
import { health } from '../controllers/health.controller.ts';
import { asyncHandler } from '../middleware/async-handler.ts';
import { notFoundHandler } from '../middleware/error-handler.ts';
import { conversationsRouter } from './conversations.routes.ts';
import { messagesRouter } from './messages.routes.ts';
import { searchRouter } from './search.routes.ts';
import { usersRouter } from './users.routes.ts';

/**
 * The API surface in one place, so adding an endpoint group is one line here rather than an edit in
 * the middle of application setup.
 */
export const apiRouter = Router();

apiRouter.get('/health', asyncHandler(health));
apiRouter.use('/users', usersRouter);
apiRouter.use('/conversations', conversationsRouter);
apiRouter.use('/messages', messagesRouter);
apiRouter.use('/search', searchRouter);

// Last within /api: an unmatched API path gets JSON rather than falling through to the SPA.
apiRouter.use(notFoundHandler);
