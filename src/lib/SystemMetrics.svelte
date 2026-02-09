<script>
  import { onMount, onDestroy } from 'svelte';
  import { subscribe, getCurrentMetrics, isWebSocketConnected } from './websocket.js';
  import Gauge from './Gauge.svelte';

  let metrics = $state(null);
  let connected = $state(false);
  let unsubscribe = null;
  let modelLoading = $state({});
  let newModelName = $state('');
  let downloadingModel = $state(false);
  let showModelManager = $state(false);
  let consoleOutput = $state([]);

  function addToConsole(message, type = 'info') {
    consoleOutput = [...consoleOutput, { message, type, timestamp: new Date().toLocaleTimeString() }];
  }

  async function handleModelAction(modelName, action) {
    modelLoading[modelName] = true;

    try {
      const response = await fetch('/api/ollama', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, model: modelName })
      });

      const result = await response.json();

      if (!response.ok) {
        console.error('Model action failed:', result.error);
      } else if (action === 'delete') {
        addToConsole(`Deleted model: ${modelName}`, 'success');
      }
    } catch (error) {
      console.error('Model action error:', error);
      addToConsole(`Error: ${error.message}`, 'error');
    } finally {
      modelLoading[modelName] = false;
    }
  }

  async function handleDownloadModel() {
    if (!newModelName.trim()) return;

    downloadingModel = true;
    const modelName = newModelName.trim();
    addToConsole(`Starting download: ${modelName}...`, 'info');

    try {
      const response = await fetch('/api/ollama', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pull', model: modelName })
      });

      const result = await response.json();

      if (!response.ok) {
        addToConsole(`Failed to download ${modelName}: ${result.error}`, 'error');
      } else {
        addToConsole(`Successfully downloaded: ${modelName}`, 'success');
        newModelName = '';
      }
    } catch (error) {
      console.error('Download error:', error);
      addToConsole(`Error: ${error.message}`, 'error');
    } finally {
      downloadingModel = false;
    }
  }

  onMount(() => {
    // Subscribe to WebSocket updates
    unsubscribe = subscribe((message) => {
      if (message.type === 'connected') {
        connected = true;
      } else if (message.type === 'disconnected') {
        connected = false;
      } else if (message.type === 'metrics') {
        metrics = message.data;
      }
    });

    // Get initial state
    metrics = getCurrentMetrics();
    connected = isWebSocketConnected();
  });

  onDestroy(() => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  });

  function formatBytes(bytes) {
    return (bytes / (1024 ** 3)).toFixed(2);
  }
</script>

<div class="dashboard">
  <div class="header">
    <div class="header-left">
      <h1>DGX Spark Status</h1>
      <div class="system-name">{metrics?.system.hostname || 'Loading...'}</div>
      {#if metrics?.uptime}
        <div class="uptime">
          Uptime: {metrics.uptime.days}d {metrics.uptime.hours}h {metrics.uptime.minutes}m
        </div>
      {/if}
    </div>
    <div class="status {connected ? 'connected' : 'disconnected'}">
      {connected ? '● Live' : '○ Disconnected'}
    </div>
  </div>

  {#if metrics}
    <div class="dashboard-grid">

      <!-- CPU Card -->
      <div class="card">
        <h2>CPU</h2>
        <div class="gauge-container">
          <Gauge value={metrics.cpu.usage.toFixed(0)} max={100} color="#76b900" label="%" />
        </div>
        <div class="metric-label">{metrics.cpu.brand}</div>
        <div class="metric-details">
          {metrics.cpu.physicalCores} Cores • {metrics.cpu.cores} Threads • {metrics.cpu.speed} GHz
        </div>
      </div>

      <!-- Memory Card -->
      <div class="card">
        <h2>Memory</h2>
        <div class="gauge-container">
          <Gauge value={metrics.memory.usagePercent.toFixed(0)} max={100} color="#00d4ff" label="%" />
        </div>
        <div class="metric-label">{metrics.memory.usedGB} / {metrics.memory.totalGB} GB</div>
        <div class="metric-details">
          Free: {metrics.memory.freeGB} GB • Active: {formatBytes(metrics.memory.active)} GB
        </div>
      </div>

      <!-- Disk Cards -->
      {#if metrics.disk && metrics.disk.length > 0}
        {#each metrics.disk.filter(d => d.mount === '/' || d.mount.startsWith('/home')) as disk}
          <div class="card">
            <h2>Disk {disk.mount === '/' ? 'Root' : disk.mount}</h2>
            <div class="gauge-container">
              <Gauge value={disk.usagePercent.toFixed(0)} max={100} color="#9c27b0" label="%" />
            </div>
            <div class="metric-label">{disk.usedGB} / {disk.sizeGB} GB</div>
            <div class="metric-details">
              Free: {disk.availableGB} GB • {disk.type}
            </div>
          </div>
        {/each}
      {/if}

      <!-- Network Card -->
      {#if metrics.network && metrics.network.length > 0}
        {@const primaryNet = metrics.network.find(n => n.iface !== 'lo' && (n.rx_sec > 0 || n.tx_sec > 0)) || metrics.network.find(n => n.iface !== 'lo') || metrics.network[0]}
        <div class="card">
          <h2>Network</h2>
          <div class="network-stats">
            <div class="network-stat">
              <div class="network-arrow">↓</div>
              <div class="network-value">{primaryNet.rx_sec_mb.toFixed(2)}</div>
              <div class="network-label">MB/s</div>
            </div>
            <div class="network-stat">
              <div class="network-arrow">↑</div>
              <div class="network-value">{primaryNet.tx_sec_mb.toFixed(2)}</div>
              <div class="network-label">MB/s</div>
            </div>
          </div>
          <div class="metric-details">
            {primaryNet.iface}
          </div>
        </div>
      {/if}

      <!-- GPU Cards -->
      {#if metrics.gpu && metrics.gpu.length > 0}
        {#each metrics.gpu as gpu, index}
          <div class="card">
            <h2>GPU {index + 1}</h2>
            {#if gpu.utilizationGpu !== null}
              <div class="gauge-container">
                <Gauge value={gpu.utilizationGpu} max={100} color="#ff9800" label="%" />
              </div>
            {/if}
            <div class="metric-label">{gpu.model || 'Unknown'}</div>
            <div class="metric-details">
              {#if gpu.utilizationGpu !== null}
                {gpu.utilizationGpu}% Usage
              {/if}
              {#if gpu.temperatureGpu}
                {#if gpu.utilizationGpu !== null} • {/if}{gpu.temperatureGpu}°C
              {/if}
              {#if gpu.powerDraw !== null && gpu.powerLimit !== null}
                {#if gpu.utilizationGpu !== null || gpu.temperatureGpu} • {/if}{gpu.powerDraw}W / {gpu.powerLimit}W
              {/if}
            </div>
          </div>
        {/each}
      {/if}

      <!-- Top Processes -->
      {#if metrics.processes && metrics.processes.length > 0}
        <div class="card processes-card">
          <h2>Top Memory</h2>
          <div class="processes-compact">
            {#each metrics.processes.slice(0, 5) as process}
              <div class="process-compact">
                <div class="process-info">
                  <div class="process-name" title="{process.command}">
                    {process.command.split(' ')[0].split('/').pop()}
                  </div>
                  <div class="process-user-compact">{process.user}</div>
                </div>
                <div class="process-stats">
                  <span class="process-mem-compact">{process.memoryGB} GB</span>
                  <span class="process-cpu-compact">{process.cpu}%</span>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Ollama -->
      {#if metrics.ollama}
        <div class="card ollama-card">
          <h2>Ollama</h2>
          {#if metrics.ollama.available}
            <div class="ollama-content">
              <div class="status-badge online">● Online</div>
              {#if metrics.ollama.models.length > 0}
                <div class="models-list">
                  {#each metrics.ollama.models.slice(0, 3) as model}
                    <div class="model-item" class:loaded={model.running}>
                      <div class="model-header">
                        <div class="model-name">{model.name}</div>
                        <button
                          class="model-action-btn"
                          class:loading={modelLoading[model.name]}
                          onclick={() => handleModelAction(model.name, model.running ? 'unload' : 'load')}
                          disabled={modelLoading[model.name]}
                        >
                          {modelLoading[model.name] ? '...' : model.running ? 'Unload' : 'Load'}
                        </button>
                      </div>
                      <div class="model-info">
                        <span class="model-size">{model.sizeGB} GB</span>
                        <span class="model-params">{model.parameters}</span>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
            <button class="gear-btn" onclick={() => showModelManager = true} title="Manage Models">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"></path>
              </svg>
            </button>
          {:else}
            <div class="status-badge offline">○ Offline</div>
          {/if}
        </div>
      {/if}

    </div>

    <div class="footer-compact">
      {new Date(metrics.timestamp).toLocaleTimeString()}
    </div>
  {:else}
    <div class="loading-state">
      <div class="loading">Loading system metrics...</div>
    </div>
  {/if}
</div>

<!-- Model Manager Modal -->
{#if showModelManager}
  <div class="modal-overlay" onclick={() => showModelManager = false}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h3>Manage Ollama Models</h3>
        <button class="modal-close" onclick={() => showModelManager = false}>×</button>
      </div>

      <div class="modal-body">
        <!-- Download Section -->
        <div class="modal-section">
          <h4>Download Model</h4>
          <div class="model-download">
            <input
              type="text"
              class="model-input"
              placeholder="model:tag (e.g., llama2:7b)"
              bind:value={newModelName}
              disabled={downloadingModel}
            />
            <button
              class="model-action-btn download-btn"
              onclick={handleDownloadModel}
              disabled={downloadingModel || !newModelName.trim()}
            >
              {downloadingModel ? 'Downloading...' : 'Download'}
            </button>
          </div>
        </div>

        <!-- Models List -->
        {#if metrics?.ollama?.models.length > 0}
          <div class="modal-section">
            <h4>Installed Models</h4>
            <div class="models-list-modal">
              {#each metrics.ollama.models as model}
                <div class="model-item-modal" class:loaded={model.running}>
                  <div class="model-info-modal">
                    <div class="model-name">{model.name}</div>
                    <div class="model-meta">
                      <span class="model-size">{model.sizeGB} GB</span>
                      <span class="model-params">{model.parameters}</span>
                    </div>
                  </div>
                  <button
                    class="model-action-btn delete-btn"
                    onclick={() => {
                      if (confirm(`Delete ${model.name}?`)) {
                        handleModelAction(model.name, 'delete');
                      }
                    }}
                    disabled={modelLoading[model.name] || model.running}
                    title={model.running ? 'Unload model first' : 'Delete model'}
                  >
                    Delete
                  </button>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Console Output -->
        {#if consoleOutput.length > 0}
          <div class="modal-section">
            <h4>Activity Log</h4>
            <div class="console">
              {#each consoleOutput as log}
                <div class="console-line {log.type}">
                  <span class="console-time">[{log.timestamp}]</span>
                  <span class="console-message">{log.message}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .dashboard {
    min-height: 100vh;
    padding: 1rem;
    max-width: 1600px;
    margin: 0 auto;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding: 0.5rem 0;
  }

  .header-left {
    display: flex;
    align-items: baseline;
    gap: 1rem;
  }

  h1 {
    margin: 0;
    color: #76b900;
    font-size: 1.75rem;
    font-weight: 600;
  }

  .system-name {
    color: #666;
    font-size: 0.85rem;
  }

  .uptime {
    color: #888;
    font-size: 0.75rem;
    margin-top: 0.25rem;
  }

  h2 {
    margin: 0 0 0.75rem 0;
    color: #76b900;
    font-size: 0.85rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    text-align: center;
    width: 100%;
  }

  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 0.75rem;
  }

  .status {
    padding: 0.4rem 0.9rem;
    border-radius: 4px;
    font-weight: 600;
    font-size: 0.85rem;
  }

  .status.connected {
    background: #1a4d1a;
    color: #76b900;
  }

  .status.disconnected {
    background: #4d1a1a;
    color: #ff6b6b;
  }

  .card {
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    padding: 1rem;
    transition: border-color 0.2s;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    text-align: center;
    min-height: 250px;
  }

  .card:hover {
    border-color: #76b900;
  }

  .gauge-container {
    display: flex;
    justify-content: center;
    margin: 0.5rem 0;
  }

  .metric-label {
    color: #aaa;
    font-size: 0.9rem;
    margin: 0.5rem 0;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .metric-details {
    color: #666;
    font-size: 0.75rem;
    margin-top: 0.75rem;
    text-align: center;
  }

  .processes-compact {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }

  .process-compact {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem;
    background: #0f0f0f;
    border-radius: 4px;
    font-size: 0.8rem;
  }

  .process-info {
    flex: 1;
    min-width: 0;
  }

  .process-name {
    color: #fff;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: 'Monaco', 'Menlo', monospace;
  }

  .process-user-compact {
    color: #00d4ff;
    font-size: 0.7rem;
  }

  .process-stats {
    display: flex;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .process-mem-compact {
    color: #76b900;
    font-weight: 600;
  }

  .process-cpu-compact {
    color: #ff9800;
  }

  .footer-compact {
    text-align: center;
    color: #444;
    font-size: 0.7rem;
    margin-top: 0.5rem;
    padding: 0.5rem 0;
  }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 50vh;
  }

  .loading {
    color: #888;
    font-size: 1.2rem;
  }

  .ollama-content {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    align-items: center;
    width: 100%;
    flex: 1;
  }

  .status-badge {
    padding: 0.4rem 0.8rem;
    border-radius: 4px;
    font-weight: 600;
    font-size: 0.85rem;
  }

  .status-badge.online {
    background: #1a4d1a;
    color: #76b900;
  }

  .status-badge.offline {
    background: #4d1a1a;
    color: #ff6b6b;
  }

  .models-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }

  .model-item {
    padding: 0.75rem;
    background: #0f0f0f;
    border-radius: 4px;
    border: 1px solid #2a2a2a;
    transition: all 0.2s;
  }

  .model-item.loaded {
    background: rgba(118, 185, 0, 0.1);
    border: 1px solid #76b900;
    box-shadow: 0 0 10px rgba(118, 185, 0, 0.2);
  }

  .ollama-card {
    position: relative;
  }

  .gear-btn {
    position: absolute;
    bottom: 0.75rem;
    right: 0.75rem;
    background: transparent;
    border: none;
    color: #888;
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s;
  }

  .gear-btn:hover {
    color: #76b900;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: #1a1a1a;
    border: 1px solid #76b900;
    border-radius: 8px;
    width: 90%;
    max-width: 600px;
    max-height: 80vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    border-bottom: 1px solid #2a2a2a;
  }

  .modal-header h3 {
    margin: 0;
    color: #76b900;
    font-size: 1.2rem;
  }

  .modal-close {
    background: transparent;
    border: none;
    color: #888;
    font-size: 2rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    transition: color 0.2s;
  }

  .modal-close:hover {
    color: #ff6b6b;
  }

  .modal-body {
    padding: 1rem;
    overflow-y: auto;
  }

  .modal-section {
    margin-bottom: 1.5rem;
  }

  .modal-section h4 {
    margin: 0 0 0.75rem 0;
    color: #aaa;
    font-size: 0.9rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .model-download {
    display: flex;
    gap: 0.5rem;
    width: 100%;
  }

  .model-input {
    flex: 1;
    padding: 0.5rem;
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #fff;
    font-size: 0.85rem;
    font-family: 'Monaco', 'Menlo', monospace;
  }

  .model-input:focus {
    outline: none;
    border-color: #76b900;
  }

  .model-input::placeholder {
    color: #666;
  }

  .model-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .models-list-modal {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .model-item-modal {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background: #0f0f0f;
    border-radius: 4px;
    border: 1px solid #2a2a2a;
    transition: all 0.2s;
  }

  .model-item-modal.loaded {
    background: rgba(118, 185, 0, 0.1);
    border: 1px solid #76b900;
  }

  .model-info-modal {
    flex: 1;
  }

  .model-meta {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.25rem;
  }

  .console {
    background: #0a0a0a;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    padding: 0.75rem;
    max-height: 200px;
    overflow-y: auto;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 0.8rem;
  }

  .console-line {
    margin-bottom: 0.5rem;
    display: flex;
    gap: 0.5rem;
  }

  .console-time {
    color: #666;
    flex-shrink: 0;
  }

  .console-message {
    color: #aaa;
  }

  .console-line.success .console-message {
    color: #76b900;
  }

  .console-line.error .console-message {
    color: #ff6b6b;
  }

  .console-line.info .console-message {
    color: #00d4ff;
  }

  .model-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .model-name {
    color: #fff;
    font-weight: 600;
    font-size: 0.9rem;
    font-family: 'Monaco', 'Menlo', monospace;
  }

  .model-action-btn {
    padding: 0.25rem 0.75rem;
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #76b900;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .model-action-btn:hover:not(:disabled) {
    background: #3a3a3a;
    border-color: #76b900;
  }

  .model-action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .delete-btn {
    color: #ff6b6b !important;
    background: #2a1a1a !important;
    border-color: #4d1a1a !important;
  }

  .delete-btn:hover:not(:disabled) {
    background: #4d1a1a !important;
    border-color: #ff6b6b !important;
  }

  .delete-btn:disabled {
    opacity: 0.3;
  }

  .download-btn {
    background: #1a4d1a;
    border-color: #2a5a2a;
  }

  .download-btn:hover:not(:disabled) {
    background: #2a5a2a;
    border-color: #76b900;
  }

  .model-info {
    display: flex;
    gap: 0.75rem;
    font-size: 0.75rem;
  }

  .model-size {
    color: #76b900;
    font-weight: 600;
  }

  .model-params {
    color: #888;
  }

  .network-stats {
    display: flex;
    gap: 2rem;
    justify-content: center;
    align-items: center;
    flex: 1;
  }

  .network-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .network-arrow {
    font-size: 1.5rem;
    color: #76b900;
  }

  .network-value {
    font-size: 1.75rem;
    font-weight: 700;
    color: #fff;
    line-height: 1;
  }

  .network-label {
    color: #888;
    font-size: 0.75rem;
  }

  @media (max-width: 768px) {
    .dashboard-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
