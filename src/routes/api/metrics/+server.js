import si from 'systeminformation';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const UPDATE_INTERVAL = 1000;
const LLAMA_PROXY = 'http://127.0.0.1:8000';
const LLAMA_SERVER = 'http://127.0.0.1:8001';

// Get all available models on disk
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
        const filename = path.split('/').pop().replace(/\.gguf.*/, '');
        // Get size
        let sizeGB = null;
        try {
          const target = path.includes('-00001-of-') ? path.substring(0, path.lastIndexOf('/')) : path;
          const { stdout: sizeOut } = await execAsync(`du -sb "${target}" 2>/dev/null | cut -f1`);
          const bytes = parseInt(sizeOut.trim());
          if (bytes > 1e9) sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
        } catch (e) {}
        models.llama.push({
          key,
          name: filename,
          path,
          sizeGB,
          ctx: ctxMap[key] || null
        });
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
      // Skip tiny/vocab files
      let sizeGB = null;
      try {
        const { stdout: sizeOut } = await execAsync(`du -sb "${dir}" 2>/dev/null | cut -f1`);
        const bytes = parseInt(sizeOut.trim());
        if (bytes < 1e9) continue; // skip small files
        sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
      } catch (e) { continue; }
      models.vllm.push({ name, sizeGB, path: dir });
    }
  } catch (e) {}

  return models;
}

// Get llama.cpp server info
async function getLlamaInfo() {
  try {
    const [healthRes, propsRes] = await Promise.allSettled([
      fetch(`${LLAMA_SERVER}/health`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${LLAMA_SERVER}/props`, { signal: AbortSignal.timeout(2000) })
    ]);

    const healthy = healthRes.status === 'fulfilled' && healthRes.value.ok;
    let model = 'unknown';
    let ctxSize = null;

    if (propsRes.status === 'fulfilled' && propsRes.value.ok) {
      const props = await propsRes.value.json();
      ctxSize = props?.default_generation_settings?.params?.n_ctx || null;
    }

    // Get model name from systemd service
    try {
      const { stdout } = await execAsync("systemctl show llama-server -p ExecStart --value 2>/dev/null | grep -oP '(?<=--model )\\S+' | xargs basename | sed 's/\\.gguf.*//'");
      model = stdout.trim() || 'unknown';
    } catch (e) {
      // Try from process
      try {
        const { stdout } = await execAsync("ps aux | grep llama-server | grep -oP '(?<=--model )\\S+' | head -1 | xargs basename | sed 's/\\.gguf.*//'");
        model = stdout.trim() || 'unknown';
      } catch (e2) {}
    }

    // Get active model key from switch-model
    let activeModel = '';
    try {
      const { stdout } = await execAsync("systemctl show llama-server -p Description --value 2>/dev/null");
      const match = stdout.match(/\(([^)]+)\)/);
      activeModel = match ? match[1] : '';
    } catch (e) {}

    return {
      engine: 'llama.cpp',
      available: healthy,
      status: healthy ? 'running' : 'stopped',
      model: activeModel || model,
      ctxSize,
      port: 8001,
      proxyPort: 8000
    };
  } catch (error) {
    return {
      engine: 'llama.cpp',
      available: false,
      status: 'stopped',
      model: null,
      ctxSize: null,
      port: 8001,
      proxyPort: 8000
    };
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

    // Try to get model info from any running vLLM
    let model = null;
    try {
      const { stdout: modelsOut } = await execAsync("curl -s --max-time 2 http://127.0.0.1:8100/v1/models 2>/dev/null");
      const data = JSON.parse(modelsOut);
      model = data?.data?.[0]?.id || null;
    } catch (e) {}

    return {
      engine: 'vLLM',
      available: containers.length > 0,
      status: containers.length > 0 ? 'running' : 'stopped',
      model,
      containers
    };
  } catch (error) {
    return { engine: 'vLLM', available: false, status: 'stopped', model: null, containers: [] };
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
        unifiedMemory: memTotal === '[N/A]'
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
    const [cpu, mem, currentLoad, osInfo, gpuData, processes, llamaInfo, vllmInfo, availableModels, fsSize, time, networkStats] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.currentLoad(),
      si.osInfo(),
      getNvidiaGPUInfo(),
      getTopProcesses(10),
      getLlamaInfo(),
      getVllmInfo(),
      getAvailableModels(),
      si.fsSize(),
      si.time(),
      si.networkStats()
    ]);

    return {
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
      network: (() => {
        const physical = networkStats.filter(n => n.iface !== 'lo' && !n.iface.startsWith('veth') && !n.iface.startsWith('br-'));
        const totalRx = physical.reduce((sum, n) => sum + (n.rx_sec || 0), 0);
        const totalTx = physical.reduce((sum, n) => sum + (n.tx_sec || 0), 0);
        const totalRxBytes = physical.reduce((sum, n) => sum + (n.rx_bytes || 0), 0);
        const totalTxBytes = physical.reduce((sum, n) => sum + (n.tx_bytes || 0), 0);
        return [{
          iface: 'all',
          rx_sec: totalRx,
          tx_sec: totalTx,
          rx_bytes: totalRxBytes,
          tx_bytes: totalTxBytes,
          rx_sec_mb: parseFloat((totalRx / (1024 ** 2)).toFixed(2)),
          tx_sec_mb: parseFloat((totalTx / (1024 ** 2)).toFixed(2))
        }, ...networkStats.filter(n => n.iface !== 'lo' && !n.iface.startsWith('veth') && !n.iface.startsWith('br-')).map(net => ({
          iface: net.iface,
          rx_sec: net.rx_sec,
          tx_sec: net.tx_sec,
          rx_bytes: net.rx_bytes,
          tx_bytes: net.tx_bytes,
          rx_sec_mb: parseFloat((net.rx_sec / (1024 ** 2)).toFixed(2)),
          tx_sec_mb: parseFloat((net.tx_sec / (1024 ** 2)).toFixed(2))
        }))];
      })()
    };
  } catch (error) {
    console.error('Error collecting metrics:', error);
    return null;
  }
}

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(':ok\n\n'));

      try {
        const metrics = await getSystemMetrics();
        if (metrics) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(metrics)}\n\n`));
        }
      } catch (error) {
        console.error('Error getting initial metrics:', error);
      }

      const interval = setInterval(async () => {
        try {
          const metrics = await getSystemMetrics();
          if (metrics) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(metrics)}\n\n`));
          }
        } catch (error) {
          console.error('Error getting metrics:', error);
          clearInterval(interval);
          controller.close();
        }
      }, UPDATE_INTERVAL);

      return () => {
        clearInterval(interval);
      };
    },
    cancel() {
      console.log('SSE client disconnected');
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}
