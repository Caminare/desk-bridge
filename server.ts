import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from './server/relay.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';

createRelay({
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  dataDir: process.env.DESKBRIDGE_DATA_DIR || rootDir,
  distDir: path.join(rootDir, 'dist'),
  serveClient: isProduction ? 'static' : 'vite',
  heartbeatMs: Number(process.env.DESKBRIDGE_HEARTBEAT_MS || 15000),
  aiRateLimitPerMin: Number(process.env.AI_RATE_LIMIT_PER_MIN || 20),
}).catch((err) => {
  console.error('Failed to start DeskBridge server:', err);
  process.exit(1);
});
