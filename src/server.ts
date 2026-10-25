import { serve } from '@hono/node-server';
import { buildApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const dbPath = process.env.DB_PATH ?? './data/app.db';

const { app } = buildApp(dbPath);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ga-food-scores listening on http://localhost:${info.port}`);
});
