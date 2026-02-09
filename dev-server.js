import { createServer } from 'vite';
import si from 'systeminformation';
import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const UPDATE_INTERVAL = 1000;
const OLLAMA_API = 'http://localhost:11434';

// Get Ollama models and status
async function getOllamaInfo() {
  try {
    const [tagsResponse, psResponse] = await Promise.all([
      fetch(`${OLLAMA_API}/api/tags`),
      fetch(`${OLLAMA_API}/api/ps`)
    ]);

    if (!tagsResponse.ok) throw new Error('Ollama not available');

    const data = await tagsResponse.json();
    const psData = psResponse.ok ? await psResponse.json() : { models: [] };

    // Get running model names from /api/ps
    const runningModelNames = psData.models.map(m => m.name);

    return {
      available: true,
      models: data.models.map(m => ({
        name: m.name,
        size: m.size,
        sizeGB: (m.size / (1024 ** 3)).toFixed(2),
        modified: m.modified_at,
        digest: m.digest.substring(0, 12),
        family: m.details?.family || 'unknown',
        parameters: m.details?.parameter_size || 'unknown',
        running: runningModelNames.includes(m.name)
      })),
      runningCount: runningModelNames.length
    };
  } catch (error) {
    return {
      available: false,
      models: [],
      runningCount: 0,
      error: error.message
    };
  }
}

// Get top memory-consuming processes
async function getTopProcesses(limit = 10) {
  try {
    const { stdout } = await execAsync(
      `ps aux --sort=-%mem | head -n ${limit + 1} | tail -n ${limit}`
    );

    const processes = stdout.trim().split('\n').map(line => {
      const parts = line.trim().split(/\s+/);
      const user = parts[0];
      const pid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const vsz = parseInt(parts[4]);
      const rss = parseInt(parts[5]);
      const command = parts.slice(10).join(' ');

      return {
        user,
        pid,
        cpu,
        mem,
        memoryMB: (rss / 1024).toFixed(1),
        memoryGB: (rss / 1024 / 1024).toFixed(2),
        command: command.length > 80 ? command.substring(0, 77) + '...' : command
      };
    });

    return processes;
  } catch (error) {
    console.error('Error getting top processes:', error.message);
    return [];
  }
}

// Get NVIDIA GPU info using nvidia-smi
async function getNvidiaGPUInfo() {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits'
    );

    const gpus = stdout.trim().split('\n').map(line => {
      const [index, name, memTotal, memUsed, memFree, utilGpu, utilMem, temp, powerDraw, powerLimit] =
        line.split(',').map(s => s.trim());

      const parseValue = (val) => {
        if (val === '[N/A]' || val === 'N/A' || val === '') return null;
        const num = parseFloat(val);
        return isNaN(num) ? null : num;
      };

      return {
        index: parseInt(index),
        model: name,
        vendor: 'NVIDIA',
        memoryTotal: parseValue(memTotal),
        memoryUsed: parseValue(memUsed),
        memoryFree: parseValue(memFree),
        memoryTotalGB: memTotal === '[N/A]' ? null : parseFloat((parseValue(memTotal) || 0).toFixed(2)),
        memoryUsedGB: memUsed === '[N/A]' ? null : parseFloat((parseValue(memUsed) || 0).toFixed(2)),
        memoryFreeGB: memFree === '[N/A]' ? null : parseFloat((parseValue(memFree) || 0).toFixed(2)),
        utilizationGpu: parseValue(utilGpu),
        utilizationMemory: parseValue(utilMem),
        temperatureGpu: parseValue(temp),
        powerDraw: parseValue(powerDraw),
        powerLimit: parseValue(powerLimit),
        unifiedMemory: memTotal === '[N/A]' // Indicate unified memory
      };
    });

    return gpus;
  } catch (error) {
    console.error('Error getting NVIDIA GPU info:', error.message);
    return [];
  }
}

// Collect system metrics
async function getSystemMetrics() {
  try {
    const [cpu, mem, currentLoad, osInfo, gpuData, processes, ollama, fsSize, time, networkStats] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.currentLoad(),
      si.osInfo(),
      getNvidiaGPUInfo(),
      getTopProcesses(10),
      getOllamaInfo(),
      si.fsSize(),
      si.time(),
      si.networkStats()
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
      gpu: gpuData,
      processes: processes,
      ollama: ollama,
      disk: fsSize.map(disk => ({
        fs: disk.fs,
        type: disk.type,
        size: disk.size,
        used: disk.used,
        available: disk.available,
        usagePercent: parseFloat(disk.use.toFixed(2)),
        mount: disk.mount,
        sizeGB: parseFloat((disk.size / (1024 ** 3)).toFixed(2)),
        usedGB: parseFloat((disk.used / (1024 ** 3)).toFixed(2)),
        availableGB: parseFloat((disk.available / (1024 ** 3)).toFixed(2))
      })),
      uptime: {
        seconds: time.uptime,
        days: Math.floor(time.uptime / 86400),
        hours: Math.floor((time.uptime % 86400) / 3600),
        minutes: Math.floor((time.uptime % 3600) / 60)
      },
      network: networkStats.map(net => ({
        iface: net.iface,
        rx_sec: net.rx_sec,
        tx_sec: net.tx_sec,
        rx_bytes: net.rx_bytes,
        tx_bytes: net.tx_bytes,
        rx_sec_mb: parseFloat((net.rx_sec / (1024 ** 2)).toFixed(2)),
        tx_sec_mb: parseFloat((net.tx_sec / (1024 ** 2)).toFixed(2))
      }))
    };

    return metrics;
  } catch (error) {
    console.error('Error collecting metrics:', error);
    return null;
  }
}

// Store active SSE clients
const sseClients = new Set();

// SSE endpoint handler
function handleSSE(req, res) {
  const clientIp = req.socket.remoteAddress;
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

async function startDevServer() {
  // Create Vite dev server with middleware mode
  const vite = await createServer({
    server: {
      host: '0.0.0.0',
      port: 9000,
      strictPort: true,
      middlewareMode: true
    }
  });

  // Create Express app
  const app = express();

  // Add SSE endpoint BEFORE Vite middleware
  app.get('/api/metrics', handleSSE);

  // Use Vite middleware
  app.use(vite.middlewares);

  // Start server
  const server = app.listen(9000, '0.0.0.0', () => {
    console.log('');
    console.log('\x1b[32m%s\x1b[0m', '  ➜ DGX Spark Status Server');
    console.log('  \x1b[36m%s\x1b[0m', `Local:   http://localhost:9000/`);
    console.log('  \x1b[36m%s\x1b[0m', `Network: http://0.0.0.0:9000/`);
    console.log('  \x1b[33m%s\x1b[0m', `SSE Endpoint: http://0.0.0.0:9000/api/metrics`);
    console.log('');
  });
}

startDevServer().catch(err => {
  console.error('Failed to start dev server:', err);
  process.exit(1);
});
