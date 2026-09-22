/**
 * Express server entry point.
 *
 * Order matters below — the user-roles sub-router MUST be mounted before
 * /api/users, otherwise Express matches '/api/users/:id' for the roles path.
 */

import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';

import { config } from './config';
import { ping, close } from './db/pool';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import userRolesRouter from './routes/user-roles';
import rolesRouter from './routes/roles';
import dentistsRouter from './routes/dentists';
import appointmentsRouter from './routes/appointments';
import availabilityRouter from './routes/availability';

const app = express();

// ------------------------------------------------------------
// Middleware
// ------------------------------------------------------------

app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin requests (curl, server-to-server).
    if (!origin) return cb(null, true);

    // Allow any localhost port in dev/preview (Expo web runs on random ports).
    if (/^http:\/\/localhost:\d+$/.test(origin)) return cb(null, true);
    if (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return cb(null, true);

    // Explicit allow list from env.
    const allowed = (config.webOrigin || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.includes(origin)) return cb(null, true);

    // Allow the deployed Expo web + any *.onrender.com preview.
    if (/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin)) return cb(null, true);

    // Otherwise, block.
    return cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  optionsSuccessStatus: 204,
}));

app.use(express.json({ limit: '256kb' }));

// ------------------------------------------------------------
// Health
// ------------------------------------------------------------

app.get('/api/health', async (_req: Request, res: Response) => {
  const dbOk = await ping();
  res.json({
    ok: dbOk,
    service: 'dental-care-server',
    db: dbOk ? 'up' : 'down',
    env: config.nodeEnv,
    time: new Date().toISOString(),
  });
});

// ------------------------------------------------------------
// API routes
// ------------------------------------------------------------

app.use('/api/auth', authRouter);

// IMPORTANT: mount sub-router BEFORE the users router.
app.use('/api/users/:userId/roles', userRolesRouter);
app.use('/api/users', usersRouter);

app.use('/api/roles', rolesRouter);
app.use('/api/dentists', dentistsRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/availability', availabilityRouter);

// ------------------------------------------------------------
// 404 + error handler
// ------------------------------------------------------------

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server] unhandled', err);
  res.status(500).json({ error: 'Internal error' });
});

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------

async function start() {
  const dbOk = await ping();
  if (!dbOk) {
    console.error('[server] Database ping failed. Check DATABASE_URL.');
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    console.log(`[server] env:            ${config.nodeEnv}`);
    console.log(`[server] allowed origin: ${config.webOrigin}`);
    console.log(`[server] health:         http://localhost:${config.port}/api/health`);
    if (config.superAdminUsername) {
      console.log(`[server] super admin username: ${config.superAdminUsername}`);
    } else {
      console.warn('[server] SUPER_ADMIN_USERNAME is not set — no super admin will be auto-granted.');
    }
  });

  // Graceful shutdown.
  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, shutting down…`);
    server.close(async () => {
      await close().catch(() => { /* noop */ });
      process.exit(0);
    });
  };
  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});