import si from 'systeminformation';

const UPDATE_INTERVAL = 1000; // Update every 1 second

// Store active SSE clients
const sseClients = new Set();

// Collect system metrics
async function getSystemMetrics() {
  try {
    const [cpu, mem, currentLoad, gpuData, osInfo] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.currentLoad(),
      si.graphics().catch(() => ({ controllers: [] })),
      si.osInfo()
    ]);

    const metrics = {
      timestamp: Date.now(),
      system: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        hostname: osInfo.hostname,
        arch: osInfo.arch
      },
      cpu: {
        manufacturer: cpu.manufacturer,
        brand: cpu.brand,
        cores: cpu.cores,
        physicalCores: cpu.physicalCores,
        speed: cpu.speed,
        usage: parseFloat(currentLoad.currentLoad.toFixed(2)),
        perCore: currentLoad.cpus.map(core => ({
          load: parseFloat(core.load.toFixed(2))
        }))
      },
      memory: {
        total: mem.total,
        free: mem.free,
        used: mem.used,
        active: mem.active,
        available: mem.available,
        usagePercent: parseFloat(((mem.used / mem.total) * 100).toFixed(2)),
        totalGB: parseFloat((mem.total / (1024 ** 3)).toFixed(2)),
        usedGB: parseFloat((mem.used / (1024 ** 3)).toFixed(2)),
        freeGB: parseFloat((mem.free / (1024 ** 3)).toFixed(2))
      },
      gpu: gpuData.controllers.map(gpu => ({
        model: gpu.model,
        vendor: gpu.vendor,
        vram: gpu.vram,
        vramDynamic: gpu.vramDynamic,
        memoryUsed: gpu.memoryUsed,
        memoryTotal: gpu.memoryTotal,
        memoryFree: gpu.memoryFree,
        temperatureGpu: gpu.temperatureGpu,
        utilizationGpu: gpu.utilizationGpu,
        utilizationMemory: gpu.utilizationMemory
      }))
    };

    return metrics;
  } catch (error) {
    console.error('Error collecting metrics:', error);
    return null;
  }
}

// Broadcast metrics to all connected clients
async function broadcastMetrics() {
  if (sseClients.size === 0) return;

  try {
    const metrics = await getSystemMetrics();
    if (!metrics) return;

    const data = `data: ${JSON.stringify(metrics)}\n\n`;

    // Send to all connected clients
    for (const client of sseClients) {
      try {
        client.res.write(data);
      } catch (error) {
        console.error(`Error sending to ${client.ip}:`, error.message);
        sseClients.delete(client);
      }
    }
  } catch (error) {
    console.error('Error broadcasting metrics:', error);
  }
}

// Start broadcasting interval
setInterval(broadcastMetrics, UPDATE_INTERVAL);

// SSE handler for SvelteKit
export function getMetricsSSE(req, res) {
  const clientIp = req.socket?.remoteAddress || 'unknown';
  console.log(`Client connected via SSE from ${clientIp}`);

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send initial comment to establish connection
  res.write(':ok\n\n');

  // Send initial metrics immediately
  getSystemMetrics().then(metrics => {
    if (metrics) {
      res.write(`data: ${JSON.stringify(metrics)}\n\n`);
    }
  }).catch(error => {
    console.error('Error getting initial metrics:', error);
  });

  // Add client to set
  const client = { res, ip: clientIp };
  sseClients.add(client);

  // Handle client disconnect
  req.on('close', () => {
    sseClients.delete(client);
    console.log(`Client disconnected from ${clientIp}`);
  });

  req.on('error', (error) => {
    sseClients.delete(client);
    console.error('SSE error:', error.message);
  });
}

// SvelteKit handle hook
export const handle = async ({ event, resolve }) => {
  return resolve(event);
};
