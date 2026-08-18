import { start } from './server.ts';

/** Entry point. Everything of substance is in app.ts (HTTP surface) and server.ts (lifecycle). */
await start();
