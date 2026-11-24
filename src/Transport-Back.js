import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { internalRouter } from './routes/internal.js';
import { gpsRouter } from './routes/gps.js';

const PORT = Number(process.env.PORT ?? 4001);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Everything here is for the office dashboard, inside the company network.
app.use('/internal', internalRouter);
// SIAMGPS lives on the internet, but only this process may dial it — the
// dashboard reaches the trackers through here, never directly.
app.use('/internal/gps', gpsRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve the built dashboard from this same process, so the VM runs one thing
// on one port instead of a web server alongside it. Mounted after the routers
// so /internal always wins.
const dashboardDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../app/build/dashboard',
);
const hasDashboard = fs.existsSync(path.join(dashboardDir, 'index.html'));
if (hasDashboard) {
  app.use(express.static(dashboardDir));
  app.get(/^\/(?!internal|health).*/, (_req, res) => {
    res.sendFile(path.join(dashboardDir, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: err.message });
});

app.listen(PORT, () => {
  console.log(`\n  Transport Monitoring mock backend`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  internal (on-prem)  http://localhost:${PORT}/internal/dashboard`);
  console.log(`  gps      (siamgps)  http://localhost:${PORT}/internal/gps/status`);
  console.log(
    hasDashboard
      ? `  dashboard           http://localhost:${PORT}/`
      : `  dashboard           ยังไม่ได้ build (ดู README)`,
  );
  console.log('');
});
