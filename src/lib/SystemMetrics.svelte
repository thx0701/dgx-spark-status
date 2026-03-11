<script>
  import { onMount, onDestroy } from 'svelte';
  import { subscribe, getCurrentMetrics, isWebSocketConnected } from './websocket.js';
  import Gauge from './Gauge.svelte';

  let metrics = $state(null);
  let connected = $state(false);
  let unsubscribe = null;

  // History for sparklines (last 60 data points = 60 seconds)
  const HISTORY_LEN = 60;
  let cpuHistory = $state(Array(HISTORY_LEN).fill(0));
  let gpuHistory = $state(Array(HISTORY_LEN).fill(0));
  let netRxHistory = $state(Array(HISTORY_LEN).fill(0));
  let netTxHistory = $state(Array(HISTORY_LEN).fill(0));

  function pushHistory(arr, val) {
    const next = [...arr.slice(1), val];
    return next;
  }

  onMount(() => {
    unsubscribe = subscribe((message) => {
      if (message.type === 'connected') {
        connected = true;
      } else if (message.type === 'disconnected') {
        connected = false;
      } else if (message.type === 'metrics') {
        metrics = message.data;
        cpuHistory = pushHistory(cpuHistory, message.data.cpu?.usage || 0);
        gpuHistory = pushHistory(gpuHistory, message.data.gpu?.[0]?.utilizationGpu || 0);
        const net = message.data.network?.find(n => n.iface === 'all') || message.data.network?.[0];
        netRxHistory = pushHistory(netRxHistory, net?.rx_sec_mb || 0);
        netTxHistory = pushHistory(netTxHistory, net?.tx_sec_mb || 0);
      }
    });
    metrics = getCurrentMetrics();
    connected = isWebSocketConnected();
  });

  onDestroy(() => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  });

  // Notes
  let editingNote = $state(null);
  let noteInput = $state('');

  function startEditNote(modelId, currentNote) {
    editingNote = modelId;
    noteInput = currentNote || '';
  }

  async function saveNote(modelId) {
    await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, note: noteInput })
    });
    editingNote = null;
  }

  function cancelEdit() { editingNote = null; }

  function getNote(modelId) {
    return metrics?.modelNotes?.[modelId] || '';
  }

  // Sparkline path generator
  function sparklinePath(data, w, h) {
    if (!data || data.length === 0) return '';
    const max = Math.max(...data, 1);
    const step = w / (data.length - 1);
    return data.map((v, i) => {
      const x = i * step;
      const y = h - (v / max) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  function sparklineArea(data, w, h) {
    const path = sparklinePath(data, w, h);
    if (!path) return '';
    return path + ` L${w},${h} L0,${h} Z`;
  }

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
    <!-- Row 1: CPU, GPU, Memory, Disk — all compact in one row -->
    <div class="stats-row">
      <!-- CPU -->
      <div class="card stat-card">
        <div class="stat-top">
          <Gauge value={metrics.cpu.usage.toFixed(0)} max={100} color="#76b900" label="%" size={56} thickness={5} />
          <div class="stat-info">
            <h2>CPU</h2>
            <div class="stat-detail">{metrics.cpu.physicalCores}C/{metrics.cpu.cores}T {metrics.cpu.speed}GHz</div>
          </div>
        </div>
        <div class="sparkline-container">
          <svg viewBox="0 0 120 28" preserveAspectRatio="none" class="sparkline">
            <path d={sparklineArea(cpuHistory, 120, 28)} fill="rgba(118,185,0,0.15)" />
            <path d={sparklinePath(cpuHistory, 120, 28)} fill="none" stroke="#76b900" stroke-width="1.5" />
          </svg>
        </div>
      </div>

      <!-- GPU -->
      {#if metrics.gpu && metrics.gpu.length > 0}
        {@const gpu = metrics.gpu[0]}
        <div class="card stat-card">
          <div class="stat-top">
            <Gauge value={gpu.utilizationGpu ?? 0} max={100} color="#ff9800" label="%" size={56} thickness={5} />
            <div class="stat-info">
              <h2>GPU</h2>
              <div class="stat-detail">
                {#if gpu.temperatureGpu}{gpu.temperatureGpu}°C{/if}
                {#if gpu.powerDraw !== null} • {gpu.powerDraw}W{/if}
              </div>
            </div>
          </div>
          <div class="sparkline-container">
            <svg viewBox="0 0 120 28" preserveAspectRatio="none" class="sparkline">
              <path d={sparklineArea(gpuHistory, 120, 28)} fill="rgba(255,152,0,0.15)" />
              <path d={sparklinePath(gpuHistory, 120, 28)} fill="none" stroke="#ff9800" stroke-width="1.5" />
            </svg>
          </div>
        </div>
      {/if}

      <!-- Unified Memory -->
      {#if metrics.processes}
        {@const totalUsedGB = (metrics.memory.total - metrics.memory.available) / (1024 ** 3)}
        {@const processRssGB = metrics.processes.reduce((s, p) => s + parseFloat(p.memoryGB), 0)}
        {@const gpuMemGB = Math.max(0, totalUsedGB - processRssGB)}
        {@const gpuPct = (gpuMemGB / metrics.memory.totalGB) * 100}
        {@const osPct = (processRssGB / metrics.memory.totalGB) * 100}
        <div class="card stat-card">
          <div class="stat-top">
            <div class="stat-info" style="width:100%">
              <h2>Memory</h2>
              <div class="mem-total-compact">{totalUsedGB.toFixed(1)} / {metrics.memory.totalGB} GB</div>
            </div>
          </div>
          <div class="mem-bar-container">
            <div class="mem-bar">
              <div class="mem-bar-gpu" style="width: {gpuPct}%"></div>
              <div class="mem-bar-os" style="width: {osPct}%"></div>
            </div>
          </div>
          <div class="mem-legend-compact">
            <span><span class="mem-dot gpu"></span>GPU {gpuMemGB.toFixed(0)}G</span>
            <span><span class="mem-dot os"></span>OS {processRssGB.toFixed(0)}G</span>
            <span><span class="mem-dot free"></span>Free {formatBytes(metrics.memory.available)}G</span>
          </div>
        </div>
      {/if}

      <!-- Disk -->
      {#if metrics.disk}
        {@const disk = metrics.disk.find(d => d.mount === '/') || metrics.disk[0]}
        <div class="card stat-card">
          <div class="stat-top">
            <div class="stat-info" style="width:100%">
              <h2>Disk</h2>
              <div class="mem-total-compact">{disk.usedGB} / {disk.sizeGB} GB</div>
            </div>
          </div>
          <div class="mem-bar-container">
            <div class="mem-bar">
              <div class="mem-bar-disk" style="width: {disk.usagePercent}%"></div>
            </div>
          </div>
          <div class="mem-legend-compact">
            <span><span class="mem-dot disk"></span>Used {disk.usagePercent}%</span>
            <span><span class="mem-dot free"></span>Free {disk.availableGB} GB</span>
          </div>
        </div>
      {/if}

      <!-- Network -->
      {#if metrics.network && metrics.network.length > 0}
        {@const net = metrics.network.find(n => n.iface === 'all') || metrics.network[0]}
        <div class="card stat-card">
          <div class="stat-top">
            <div class="stat-info" style="width:100%">
              <h2>Network</h2>
              <div class="net-stats">
                <span class="net-rx">↓ {net.rx_sec_mb.toFixed(2)} MB/s</span>
                <span class="net-tx">↑ {net.tx_sec_mb.toFixed(2)} MB/s</span>
              </div>
            </div>
          </div>
          <div class="sparkline-container">
            <svg viewBox="0 0 120 28" preserveAspectRatio="none" class="sparkline">
              <path d={sparklineArea(netRxHistory, 120, 28)} fill="rgba(0,212,255,0.1)" />
              <path d={sparklinePath(netRxHistory, 120, 28)} fill="none" stroke="#00d4ff" stroke-width="1.5" />
              <path d={sparklinePath(netTxHistory, 120, 28)} fill="none" stroke="#76b900" stroke-width="1" opacity="0.6" />
            </svg>
          </div>
        </div>
      {/if}
    </div>

    <!-- Row 2: Processes (compact) -->
    {#if metrics.processes && metrics.processes.length > 0}
      <div class="card processes-row">
        <h2>Top Processes</h2>
        <div class="processes-compact">
          {#each metrics.processes.slice(0, 5) as process}
            <div class="process-compact">
              <div class="process-info">
                <span class="process-name" title="{process.command}">
                  {process.command.split(' ')[0].split('/').pop()}
                </span>
                <span class="process-user-compact">{process.user}</span>
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

    <!-- Row 3: All Models side by side -->
    {#if metrics.inference}
      <div class="models-row">
        <!-- llama.cpp -->
        <div class="card models-card">
          <h2>llama.cpp
            {#if metrics.inference.llama.status === 'running'}
              <span class="engine-status running">● :{metrics.inference.llama.proxyPort}</span>
            {:else if metrics.inference.llama.status === 'loading'}
              <span class="engine-status loading">◐ loading :{metrics.inference.llama.port}</span>
            {:else}
              <span class="engine-status stopped">○ stopped</span>
            {/if}
          </h2>
          <div class="models-list">
            {#if metrics.inference.availableModels?.llama}
              {#each metrics.inference.availableModels.llama as model}
                {@const isRunning = metrics.inference.llama.status !== 'stopped' && (metrics.inference.llama.model === model.key || (metrics.inference.llama.model && model.name && metrics.inference.llama.model.includes(model.name.split('-00')[0])))}
                {@const noteId = `llama:${model.key}`}
                <div class="model-item {isRunning ? 'loaded' : ''}">
                  <div class="model-header-row">
                    <div class="model-name">{model.name || model.key}</div>
                    {#if isRunning}<span class="running-badge">{metrics.inference.llama.status === 'loading' ? 'LOADING' : 'RUNNING'}</span>{/if}
                  </div>
                  <div class="model-info">
                    {#if model.sizeGB}<span class="model-size">{model.sizeGB} GB</span>{/if}
                    {#if isRunning && metrics.inference.llama.quantFormat}<span class="model-quant">{metrics.inference.llama.quantFormat}</span>{/if}
                    {#if isRunning && metrics.inference.llama.paramSize}<span class="model-params">{metrics.inference.llama.paramSize}</span>{/if}
                    {#if model.ctx}<span class="model-params">ctx: {(model.ctx / 1024).toFixed(0)}K</span>{/if}
                    {#if isRunning && metrics.inference.llama.ctxSize}<span class="model-params active-ctx">active: {(metrics.inference.llama.ctxSize / 1024).toFixed(0)}K</span>{/if}
                  </div>
                  {#if editingNote === noteId}
                    <div class="note-edit">
                      <textarea bind:value={noteInput} placeholder="Add note..." rows="2" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(noteId); } if (e.key === 'Escape') cancelEdit(); }}></textarea>
                      <div class="note-actions">
                        <button class="note-btn save" onclick={() => saveNote(noteId)}>Save</button>
                        <button class="note-btn cancel" onclick={cancelEdit}>Cancel</button>
                      </div>
                    </div>
                  {:else}
                    <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                      {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
                      <span class="note-edit-icon" title="Edit note">✏️</span>
                    </div>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        </div>

        <!-- vLLM -->
        <div class="card models-card">
          <h2>vLLM
            {#if metrics.inference.vllm.status === 'running'}
              <span class="engine-status running">● running</span>
            {:else if metrics.inference.vllm.status === 'loading' || metrics.inference.vllm.status === 'starting'}
              <span class="engine-status loading">◐ {metrics.inference.vllm.status}</span>
            {:else}
              <span class="engine-status stopped">○ stopped</span>
            {/if}
          </h2>
          <div class="models-list">
            {#if metrics.inference.availableModels?.vllm && metrics.inference.availableModels.vllm.length > 0}
              {#each metrics.inference.availableModels.vllm as model}
                {@const isRunning = metrics.inference.vllm.status !== 'stopped' && metrics.inference.vllm.model && model.name.includes(metrics.inference.vllm.model)}
                {@const noteId = `vllm:${model.name}`}
                <div class="model-item {isRunning ? 'loaded' : ''}">
                  <div class="model-header-row">
                    <div class="model-name">{model.name.split('/').pop()}</div>
                    {#if isRunning}<span class="running-badge">{metrics.inference.vllm.status === 'running' ? 'RUNNING' : 'LOADING'}</span>{/if}
                  </div>
                  <div class="model-info">
                    <span class="model-size">{model.sizeGB} GB</span>
                    <span class="model-params">{model.name.split('/')[0]}</span>
                  </div>
                  {#if editingNote === noteId}
                    <div class="note-edit">
                      <textarea bind:value={noteInput} placeholder="Add note..." rows="2" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(noteId); } if (e.key === 'Escape') cancelEdit(); }}></textarea>
                      <div class="note-actions">
                        <button class="note-btn save" onclick={() => saveNote(noteId)}>Save</button>
                        <button class="note-btn cancel" onclick={cancelEdit}>Cancel</button>
                      </div>
                    </div>
                  {:else}
                    <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                      {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
                      <span class="note-edit-icon" title="Edit note">✏️</span>
                    </div>
                  {/if}
                </div>
              {/each}
            {:else}
              <div class="model-info"><span class="model-params">No models downloaded</span></div>
            {/if}
          </div>
        </div>

        <!-- Ollama -->
        {#if metrics.inference.ollama}
          <div class="card models-card">
            <h2>Ollama {#if metrics.inference.ollama.available}<span class="engine-status running">● :{metrics.inference.ollama.port}</span>{:else}<span class="engine-status stopped">○ stopped</span>{/if}</h2>
            <div class="models-list">
              {#if metrics.inference.ollama.models && metrics.inference.ollama.models.length > 0}
                {#each metrics.inference.ollama.models as model}
                  {@const isRunning = metrics.inference.ollama.runningModel === model.name}
                  {@const noteId = `ollama:${model.name}`}
                  <div class="model-item {isRunning ? 'loaded' : ''}">
                    <div class="model-header-row">
                      <div class="model-name">{model.name}</div>
                      {#if isRunning}<span class="running-badge">LOADED</span>{/if}
                    </div>
                    <div class="model-info">
                      {#if model.sizeGB}<span class="model-size">{model.sizeGB} GB</span>{/if}
                      {#if model.quantFormat}<span class="model-quant">{model.quantFormat}</span>{/if}
                      {#if model.paramSize}<span class="model-params">{model.paramSize}</span>{/if}
                      {#if model.family}<span class="model-params">{model.family}</span>{/if}
                    </div>
                    {#if editingNote === noteId}
                      <div class="note-edit">
                        <textarea bind:value={noteInput} placeholder="Add note..." rows="2" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(noteId); } if (e.key === 'Escape') cancelEdit(); }}></textarea>
                        <div class="note-actions">
                          <button class="note-btn save" onclick={() => saveNote(noteId)}>Save</button>
                          <button class="note-btn cancel" onclick={cancelEdit}>Cancel</button>
                        </div>
                      </div>
                    {:else}
                      <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                        {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
                        <span class="note-edit-icon" title="Edit note">✏️</span>
                      </div>
                    {/if}
                  </div>
                {/each}
              {:else}
                <div class="model-info"><span class="model-params">No models</span></div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <div class="footer-compact">
      {new Date(metrics.timestamp).toLocaleTimeString()}
    </div>
  {:else}
    <div class="loading-state">
      <div class="loading">Loading system metrics...</div>
    </div>
  {/if}
</div>

<style>
  .dashboard {
    min-height: 100vh;
    padding: 0.5rem;
    max-width: 1600px;
    margin: 0 auto;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
    padding: 0.25rem 0;
  }

  .header-left {
    display: flex;
    align-items: baseline;
    gap: 1rem;
  }

  h1 { margin: 0; color: #76b900; font-size: 1.3rem; font-weight: 600; }
  .system-name { color: #666; font-size: 0.85rem; }
  .uptime { color: #888; font-size: 0.75rem; }

  h2 {
    margin: 0 0 0.3rem 0;
    color: #76b900;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .status {
    padding: 0.3rem 0.7rem;
    border-radius: 4px;
    font-weight: 600;
    font-size: 0.8rem;
  }
  .status.connected { background: #1a4d1a; color: #76b900; }
  .status.disconnected { background: #4d1a1a; color: #ff6b6b; }

  .card {
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    padding: 0.5rem;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: #76b900; }

  /* Row 1: Stats row — horizontal scroll on mobile */
  .stats-row {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-height: 0;
  }

  .stat-top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .stat-info {
    flex: 1;
    min-width: 0;
  }

  .stat-info h2 { margin: 0; text-align: left; }

  .stat-detail {
    color: #888;
    font-size: 0.65rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sparkline-container {
    width: 100%;
    height: 28px;
  }

  .sparkline {
    width: 100%;
    height: 100%;
  }

  /* Memory compact */
  .mem-total-compact {
    font-size: 0.9rem;
    font-weight: 700;
    color: #fff;
  }

  .mem-bar-container { width: 100%; }

  .mem-bar {
    width: 100%;
    height: 10px;
    background: #2a2a2a;
    border-radius: 5px;
    overflow: hidden;
    display: flex;
  }
  .mem-bar-gpu { height: 100%; background: #ff9800; transition: width 0.5s; }
  .mem-bar-os { height: 100%; background: #00d4ff; transition: width 0.5s; }
  .mem-bar-disk { height: 100%; background: #9c27b0; transition: width 0.5s; }

  .mem-legend-compact {
    display: flex;
    gap: 0.5rem;
    font-size: 0.6rem;
    color: #888;
    flex-wrap: wrap;
  }

  .mem-dot {
    width: 6px; height: 6px; border-radius: 50%;
    display: inline-block; vertical-align: middle; margin-right: 2px;
  }
  .mem-dot.gpu { background: #ff9800; }
  .mem-dot.os { background: #00d4ff; }
  .mem-dot.disk { background: #9c27b0; }
  .mem-dot.free { background: #2a2a2a; border: 1px solid #555; }

  /* Network */
  .net-stats {
    display: flex;
    gap: 0.75rem;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .net-rx { color: #00d4ff; }
  .net-tx { color: #76b900; }

  /* Processes row */
  .processes-row {
    margin-bottom: 0.5rem;
  }

  .processes-row h2 { text-align: left; }

  .processes-compact {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 0.3rem;
    width: 100%;
  }

  .process-compact {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.25rem 0.4rem;
    background: #0f0f0f;
    border-radius: 4px;
    font-size: 0.65rem;
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

  .process-user-compact { color: #00d4ff; font-size: 0.6rem; }

  .process-stats {
    display: flex;
    gap: 0.4rem;
    flex-shrink: 0;
    font-size: 0.65rem;
  }
  .process-mem-compact { color: #76b900; font-weight: 600; }
  .process-cpu-compact { color: #ff9800; }

  /* Models row */
  .models-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .models-card {
    min-height: 0;
    max-height: 450px;
    text-align: left;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .models-card .models-list {
    overflow-y: auto;
    flex: 1;
  }

  .models-card h2 {
    display: flex;
    justify-content: space-between;
    align-items: center;
    text-align: left;
  }

  .engine-status {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
  }
  .engine-status.running { color: #76b900; }
  .engine-status.loading { color: #ffd166; }
  .engine-status.stopped { color: #ff6b6b; }

  .models-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: 100%;
  }

  .model-item {
    padding: 0.35rem 0.4rem;
    background: #0f0f0f;
    border-radius: 4px;
    border: 1px solid #2a2a2a;
    transition: all 0.2s;
  }

  .model-item.loaded {
    background: rgba(118, 185, 0, 0.1);
    border: 1px solid #76b900;
    box-shadow: 0 0 8px rgba(118, 185, 0, 0.2);
  }

  .model-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .model-name {
    color: #fff;
    font-weight: 600;
    font-size: 0.8rem;
    font-family: 'Monaco', 'Menlo', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .running-badge {
    font-size: 0.55rem;
    font-weight: 700;
    color: #76b900;
    background: #1a4d1a;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  .model-info {
    display: flex;
    gap: 0.5rem;
    font-size: 0.7rem;
    flex-wrap: wrap;
  }

  .model-size { color: #76b900; font-weight: 600; }

  .model-quant {
    color: #e6a817;
    font-weight: 600;
    background: rgba(230, 168, 23, 0.15);
    padding: 0px 4px;
    border-radius: 3px;
    font-size: 0.7em;
  }

  .model-params { color: #888; }
  .model-params.active-ctx { color: #76b900; font-weight: 600; }

  /* Notes */
  .note-display {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-top: 0.2rem;
    cursor: pointer;
    min-height: 1.2rem;
  }
  .note-display:hover .note-edit-icon { opacity: 1; }
  .note-text { color: #aaa; font-size: 0.7em; line-height: 1.3; white-space: pre-wrap; }
  .note-edit-icon { opacity: 0.2; font-size: 0.65em; transition: opacity 0.2s; flex-shrink: 0; }

  .note-edit { margin-top: 0.2rem; }
  .note-edit textarea {
    width: 100%;
    background: #1a1a2e;
    border: 1px solid #444;
    color: #ddd;
    border-radius: 4px;
    padding: 0.3rem;
    font-size: 0.75em;
    font-family: inherit;
    resize: vertical;
  }
  .note-edit textarea:focus { outline: none; border-color: #76b900; }

  .note-actions { display: flex; gap: 0.3rem; margin-top: 0.2rem; }
  .note-btn { padding: 2px 8px; border: none; border-radius: 3px; cursor: pointer; font-size: 0.7em; }
  .note-btn.save { background: #76b900; color: #000; }
  .note-btn.cancel { background: #444; color: #ccc; }

  .footer-compact {
    text-align: center;
    color: #444;
    font-size: 0.65rem;
    margin-top: 0.3rem;
    padding: 0.3rem 0;
  }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 50vh;
  }
  .loading { color: #888; font-size: 1.2rem; }

  /* Responsive */
  @media (max-width: 1200px) {
    .stats-row { grid-template-columns: repeat(3, 1fr); }
    .models-row { grid-template-columns: repeat(2, 1fr); }
    .processes-compact { grid-template-columns: repeat(3, 1fr); }
  }

  @media (max-width: 768px) {
    .stats-row { grid-template-columns: repeat(2, 1fr); }
    .models-row { grid-template-columns: 1fr; }
    .processes-compact { grid-template-columns: 1fr; }
  }
</style>
