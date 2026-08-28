/**
 * Express server entry point.
 */

import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';

import { config } from './config';
import { ping } from './db/pool';
import usersRouter from './routes/users';
import authRouter from './routes/auth';  // <-- add near the other imports at top
import dentistsRouter from './routes/dentists';
import appointmentsRouter from './routes/appointments';

const app = express();

const allowedOrigins = (process.env.WEB_ORIGIN ?? '').split(',').map(s => s.trim());
app.use(cors({ origin: allowedOrigins }));

app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'dental-care-server',
    time: new Date().toISOString(),
    env: config.nodeEnv,
  });
});

app.use('/api/users', usersRouter);

app.use('/api/auth', authRouter);

app.use('/api/dentists', dentistsRouter);
app.use('/api/appointments', appointmentsRouter);

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server] unhandled', err);
  res.status(500).json({ error: 'Internal error' });
});

async function start() {
  const dbOk = await ping();
  if (!dbOk) {
    console.error('[server] Database ping failed. Is DATABASE_URL correct?');
    console.error('[server] Run "npm run db:migrate && npm run db:seed" once the DB is reachable.');
    process.exit(1);
  }
  app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    console.log(`[server] allowed origin: ${config.webOrigin}`);
    console.log(`[server] health:           http://localhost:${config.port}/api/health`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
