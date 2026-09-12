import express, { type Express } from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './server/routes.ts';
import { getDb } from './server/db.ts';

export async function createApp(): Promise<Express> {
  const app = express();

  // Universal Origin & CORS handling (supports all origins, iframes, preview URLs, and dev environments)
  app.use((req, res, next) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // Global middlewares
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());

  // Mount API routes FIRST
  app.use('/api', apiRouter);

  // Guarantee that unmatched /api calls never reach Vite or return HTML
  app.use('/api', (req, res) => {
    res.status(404).json({
      error: {
        code: 'API_ENDPOINT_NOT_FOUND',
        message: `API endpoint ${req.method} ${req.originalUrl} not found.`,
        retryable: false,
      },
    });
  });

  // Vite middleware for development vs static build in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0', port: 3000 },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return app;
}

async function startServer() {
  const app = await createApp();
  try {
    console.log('Bootstrapping ClaritySQL database layer...');
    await getDb();
    console.log('Database layer ready.');
    if (process.env.NODE_ENV !== 'production') {
      const { seedDemoOrganizationsAndUsers } = await import('./server/demo-seed.ts');
      await seedDemoOrganizationsAndUsers();
    }
  } catch (err) {
    console.error('Failed to initialize database on startup:', err);
  }

  app.listen(3000, '0.0.0.0', () => {
    console.log('ClaritySQL server running on http://0.0.0.0:3000');
  });
}

if (process.env.VERCEL !== '1') {
  startServer().catch(err => {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  });
}
