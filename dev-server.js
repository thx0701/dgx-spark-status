import { createServer } from 'vite';
import si from 'systeminformation';
import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const execAsync = promisify(exec);
const UPDATE_INTERVAL = 1000;
const LLAMA_SERVER = 'http://127.0.0.1:8001';

// Model notes — user-editable, stored in JSON file
const NOTES_FILE = '/opt/dgx-spark-status/model-notes.json';

function loadNotes() {
  try {
    if (existsSync(NOTES_FILE)) return JSON.parse(readFileSync(NOTES_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveNotes(notes) {
  writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), 'utf8');
}

function parseModelMeta(modelId) {
  if (!modelId) return { model: null, quantFormat: null, paramSize: null };
  const quantMatch = modelId.match(/(Q\d+_K(?:_[A-Z]+)?|Q\d+_\d+|F16|F32|BF16|FP8|MXFP4)/i);
  const model = modelId
    .replace(/-\d+-of-\d+\.gguf.*$/, '')
    .replace(/\.gguf.*$/, '')
    .replace(/^.*\//, '');
  const paramMatch = model.match(/(\d+B)/i);
  return {
    model,
    quantFormat: quantMatch ? quantMatch[1] : null,
    paramSize: paramMatch ? paramMatch[1] : null
  };
}

async function getAvailableModels() {
  const models = { llama: [], vllm: [] };

  // Scan switch-model.sh for llama.cpp model definitions
  try {
    const { stdout } = await execAsync("grep -E '^MODELS\\[' /usr/local/bin/switch-model.sh 2>/dev/null");
    const ctxOut = (await execAsync("grep -E '^CTX\\[' /usr/local/bin/switch-model.sh 2>/dev/null").catch(() => ({ stdout: '' }))).stdout;
    const ctxMap = {};
    for (const line of ctxOut.trim().split('\n')) {
      const m = line.match(/^CTX\[(\w+)\]="?(\d+)"?/);
      if (m) ctxMap[m[1]] = parseInt(m[2]);
    }
    for (const line of stdout.trim().split('\n')) {
      const m = line.match(/^MODELS\[(\w+)\]="([^"]+)"/);
      if (m) {
        const key = m[1];
        const path = m[2];
        const filename = path.split('/').pop().replace(/\.gguf.*/, '').replace(/-\d+-of-\d+$/, '').replace(/^stepfun-ai_/, '');
        let sizeGB = null;
        try {
          // For multi-file models use directory, for single file use the file itself
          const target = path.includes('-00001-of-') ? path.substring(0, path.lastIndexOf('/')) : path;
          const { stdout: sizeOut } = await execAsync(`du -sb "${target}" 2>/dev/null | cut -f1`);
          const bytes = parseInt(sizeOut.trim());
          if (bytes > 1e9) sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
        } catch (e) {}
        models.llama.push({ key, name: filename, path, sizeGB, ctx: ctxMap[key] || null });
      }
    }
  } catch (e) {}

  // Scan HuggingFace cache for vLLM models
  try {
    const { stdout } = await execAsync("ls -d /root/.cache/huggingface/hub/models--*/ 2>/dev/null");
    for (const dir of stdout.trim().split('\n').filter(Boolean)) {
      const dirClean = dir.replace(/\/+$/, '');
      const basename = dirClean.split('/').pop();
      const name = basename.replace(/^models--/, '').replace(/--/g, '/');
      let sizeGB = null;
      try {
        const { stdout: sizeOut } = await execAsync(`du -sb "${dir}" 2>/dev/null | cut -f1`);
        const bytes = parseInt(sizeOut.trim());
        if (bytes < 1e9) continue;
        sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
      } catch (e) { continue; }
      models.vllm.push({ name, sizeGB, path: dir });
    }
  } catch (e) {}

  // Scan /opt/models/ for locally downloaded vLLM models
  try {
    const { stdout } = await execAsync("ls -d /opt/models/*/ 2>/dev/null");
    for (const dir of stdout.trim().split('\n').filter(Boolean)) {
      const dirClean = dir.replace(/\/+$/, '');
      const name = dirClean.split('/').pop();
      let sizeGB = null;
      try {
        const { stdout: sizeOut } = await execAsync(`du -sb "${dirClean}" 2>/dev/null | cut -f1`);
        const bytes = parseInt(sizeOut.trim());
        if (bytes < 1e9) continue;
        sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
      } catch (e) { continue; }
      models.vllm.push({ name, sizeGB, path: dirClean });
    }
  } catch (e) {}

  return models;
}

// Get llama.cpp server info
async function getLlamaInfo() {
  try {
    const [healthRes, propsRes, slotsRes] = await Promise.allSettled([
      fetch(`${LLAMA_SERVER}/health`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${LLAMA_SERVER}/props`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${LLAMA_SERVER}/slots`, { signal: AbortSignal.timeout(2000) })
    ]);

    let healthy = false;
    let loading = false;
    let processRunning = false;
    let model = 'unknown';
    let ctxSize = null;
    let quantFormat = null;
    let paramSize = null;

    if (healthRes.status === 'fulfilled') {
      healthy = healthRes.value.ok;
      if (!healthy) {
        try {
          const err = await healthRes.value.json();
          const msg = err?.error?.message || '';
          if (/loading model/i.test(msg)) loading = true;
        } catch (e) {}
      }
    }

    // Try /slots first (newer llama-server), fallback to /props
    if (slotsRes.status === 'fulfilled' && slotsRes.value.ok) {
      const slots = await slotsRes.value.json();
      if (Array.isArray(slots) && slots.length > 0) {
        ctxSize = slots[0]?.n_ctx || null;
      }
    }
    if (!ctxSize && propsRes.status === 'fulfilled') {
      if (propsRes.value.ok) {
        const props = await propsRes.value.json();
        ctxSize = props?.default_generation_settings?.params?.n_ctx || null;
      } else {
        try {
          const err = await propsRes.value.json();
          const msg = err?.error?.message || '';
          if (/loading model/i.test(msg)) loading = true;
        } catch (e) {}
      }
    }

    // Get model name from /v1/models API (includes full filename with quant format)
    try {
      const modelsRes = await fetch(`${LLAMA_SERVER}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const modelId = modelsData?.data?.[0]?.id || '';
        if (modelId) {
          const parsed = parseModelMeta(modelId);
          model = parsed.model || model;
          quantFormat = parsed.quantFormat || quantFormat;
          paramSize = parsed.paramSize || paramSize;
        }
      } else {
        try {
          const err = await modelsRes.json();
          const msg = err?.error?.message || '';
          if (/loading model/i.test(msg)) loading = true;
        } catch (e) {}
      }
    } catch (e) {}

    // Fallback to running process if API isn't ready yet.
    try {
      const { stdout: psOut } = await execAsync("ps -eo args | grep -E '[/]llama-server ' | grep -v grep | head -n 1");
      const cmd = (psOut || '').trim();
      if (cmd) {
        processRunning = true;
        const modelMatch = cmd.match(/--model\s+(\S+)/);
        if (modelMatch) {
          const path = modelMatch[1];
          if (model === 'unknown') {
            const base = path.split('/').pop() || path;
            model = base.replace(/-\d+-of-\d+\.gguf.*$/, '').replace(/\.gguf.*$/, '');
          }
          if (!quantFormat || !paramSize) {
            const parsed = parseModelMeta(path);
            quantFormat = parsed.quantFormat || quantFormat;
            paramSize = parsed.paramSize || paramSize;
          }
        }
        if (!ctxSize) {
          const ctxMatch = cmd.match(/--ctx-size\s+(\d+)/);
          if (ctxMatch) ctxSize = parseInt(ctxMatch[1], 10);
        }
      }
    } catch (e) {}

    // Fallback to systemctl/ps if API didn't work
    if (model === 'unknown') {
      try {
        const { stdout } = await execAsync("systemctl show llama-server -p Description --value 2>/dev/null");
        const match = stdout.match(/\(([^)]+)\)/);
        if (match) model = match[1];
      } catch (e) {}
    }

    const status = healthy ? 'running' : (loading || processRunning ? 'loading' : 'stopped');

    return {
      engine: 'llama.cpp',
      available: status !== 'stopped',
      status,
      model,
      ctxSize,
      quantFormat,
      paramSize,
      port: 8001,
      proxyPort: 8000
    };
  } catch (error) {
    return { engine: 'llama.cpp', available: false, status: 'stopped', model: null, ctxSize: null, port: 8001, proxyPort: 8000 };
  }
}

// Get vLLM container info
async function getVllmInfo() {
  try {
    const { stdout } = await execAsync("docker ps --filter 'name=vllm' --format '{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null");
    const running = stdout.trim();
    let containers = [];
    if (running) {
      containers = running.split('\n').map(line => {
        const [name, status, ports] = line.split('|');
        return { name, status, ports };
      });
    }

    let model = null;
    let modelAlias = null;
    let modelFromPath = null;
    let loading = false;
    const modelEndpoints = [
      'http://127.0.0.1:8100/v1/models',
      'http://127.0.0.1:8102/v1/models',
      'http://127.0.0.1:8109/v1/models'
    ];
    for (const endpoint of modelEndpoints) {
      try {
        const { stdout: modelsOut } = await execAsync(`curl -s --max-time 2 ${endpoint} 2>/dev/null || true`);
        if (!modelsOut) continue;
        if (/Loading model/i.test(modelsOut)) {
          loading = true;
          continue;
        }
        const data = JSON.parse(modelsOut);
        modelAlias = data?.data?.[0]?.id || modelAlias;
        if (modelAlias) break;
      } catch (e) {
        if (/Loading model/i.test(String(e?.message || ''))) loading = true;
      }
    }

    // Parse served alias + actual model path from docker command line.
    if (containers.length > 0) {
      try {
        const names = containers.map(c => c.name).join(' ');
        const { stdout: inspectOut } = await execAsync(
          `docker inspect ${names} --format '{{.Name}}|{{json .Config.Cmd}}' 2>/dev/null || true`
        );
        for (const line of (inspectOut || '').trim().split('\n').filter(Boolean)) {
          const parts = line.split('|');
          if (parts.length < 2) continue;
          const cmd = JSON.parse(parts[1]);
          const servedIdx = cmd.indexOf('--served-model-name');
          if (servedIdx >= 0 && cmd[servedIdx + 1]) {
            modelAlias = modelAlias || cmd[servedIdx + 1];
          }
          const serveIdx = cmd.indexOf('serve');
          if (serveIdx >= 0 && cmd[serveIdx + 1]) {
            const rawPath = cmd[serveIdx + 1];
            modelFromPath = rawPath.split('/').filter(Boolean).pop() || rawPath;
          }
          if (modelAlias || modelFromPath) {
            break;
          }
        }
      } catch (e) {}
    }

    // Prefer real model name for dashboard matching; keep alias for reference.
    model = modelFromPath || modelAlias || model;

    const status = containers.length === 0 ? 'stopped' : (model ? 'running' : (loading ? 'loading' : 'starting'));

    return {
      engine: 'vLLM',
      available: containers.length > 0,
      status,
      model,
      modelAlias,
      containers
    };
  } catch (error) {
    return { engine: 'vLLM', available: false, status: 'stopped', model: null, containers: [] };
  }
}

// Get Ollama info
async function getOllamaInfo() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { engine: 'Ollama', available: false, status: 'stopped', models: [], port: 11434 };
    const data = await res.json();
    const models = (data.models || []).map(m => {
      const sizeGB = m.size ? parseFloat((m.size / (1024 ** 3)).toFixed(1)) : null;
      // Parse quant from model details or name
      const quantFormat = m.details?.quantization_level || null;
      const paramSize = m.details?.parameter_size || null;
      return {
        name: m.name,
        sizeGB,
        quantFormat,
        paramSize,
        family: m.details?.family || null,
        modified: m.modified_at
      };
    });

    // Check if any model is currently loaded (running)
    let runningModel = null;
    try {
      const psRes = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(2000) });
      if (psRes.ok) {
        const psData = await psRes.json();
        if (psData.models && psData.models.length > 0) {
          runningModel = psData.models[0].name;
        }
      }
    } catch (e) {}

    return {
      engine: 'Ollama',
      available: true,
      status: 'running',
      models,
      runningModel,
      port: 11434
    };
  } catch (error) {
    return { engine: 'Ollama', available: false, status: 'stopped', models: [], port: 11434 };
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
    const [cpu, mem, currentLoad, osInfo, gpuData, processes, llamaInfo, vllmInfo, ollamaInfo, availableModels, fsSize, time, networkStats] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.currentLoad(),
      si.osInfo(),
      getNvidiaGPUInfo(),
      getTopProcesses(10),
      getLlamaInfo(),
      getVllmInfo(),
      getOllamaInfo(),
      getAvailableModels(),
      si.fsSize(),
      si.time(),
      si.networkStats()
    ]);

    const physical = networkStats.filter(n => n.iface !== 'lo' && !n.iface.startsWith('veth') && !n.iface.startsWith('br-'));
    const totalRx = physical.reduce((sum, n) => sum + (n.rx_sec || 0), 0);
    const totalTx = physical.reduce((sum, n) => sum + (n.tx_sec || 0), 0);
    const totalRxBytes = physical.reduce((sum, n) => sum + (n.rx_bytes || 0), 0);
    const totalTxBytes = physical.reduce((sum, n) => sum + (n.tx_bytes || 0), 0);

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
      inference: {
        llama: llamaInfo,
        vllm: vllmInfo,
        ollama: ollamaInfo,
        availableModels
      },
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
      network: [{
        iface: 'all',
        rx_sec: totalRx,
        tx_sec: totalTx,
        rx_bytes: totalRxBytes,
        tx_bytes: totalTxBytes,
        rx_sec_mb: parseFloat((totalRx / (1024 ** 2)).toFixed(2)),
        tx_sec_mb: parseFloat((totalTx / (1024 ** 2)).toFixed(2))
      }, ...physical.map(net => ({
        iface: net.iface,
        rx_sec: net.rx_sec,
        tx_sec: net.tx_sec,
        rx_bytes: net.rx_bytes,
        tx_bytes: net.tx_bytes,
        rx_sec_mb: parseFloat((net.rx_sec / (1024 ** 2)).toFixed(2)),
        tx_sec_mb: parseFloat((net.tx_sec / (1024 ** 2)).toFixed(2))
      }))]
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
    metrics.modelNotes = loadNotes();

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

  // Model notes API
  app.use(express.json());
  app.get('/api/notes', (req, res) => {
    res.json(loadNotes());
  });
  app.post('/api/notes', (req, res) => {
    const { modelId, note } = req.body;
    if (!modelId) return res.status(400).json({ error: 'modelId required' });
    const notes = loadNotes();
    if (note && note.trim()) {
      notes[modelId] = note.trim();
    } else {
      delete notes[modelId];
    }
    saveNotes(notes);
    res.json({ ok: true, notes });
  });

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
