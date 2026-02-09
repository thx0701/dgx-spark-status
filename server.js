import { handler } from './build/handler.js';
import express from 'express';

const app = express();

// Use SvelteKit handler (includes SSE endpoint at /api/metrics)
app.use(handler);

const PORT = 9000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`SSE endpoint available at http://0.0.0.0:${PORT}/api/metrics`);
});
