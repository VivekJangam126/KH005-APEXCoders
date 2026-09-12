import type { Request, Response } from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../dist/server.cjs') as typeof import('../server.ts');

let appPromise: ReturnType<typeof createApp> | null = null;

export default async function handler(req: Request, res: Response) {
  appPromise = appPromise || createApp();
  const app = await appPromise;
  return app(req, res);
}
