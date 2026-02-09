# DGX Spark Status

Real-time system monitoring dashboard for DGX systems with comprehensive GPU, CPU, memory metrics and Ollama LLM model management.

## Features

### System Monitoring
- **CPU Metrics** - Real-time CPU usage with per-core monitoring, brand info, and thread count
- **Memory Tracking** - Total, used, free, and active memory with percentage gauges
- **GPU Monitoring** - NVIDIA GPU utilization, memory, temperature, and power draw via nvidia-smi
- **Disk Usage** - Multi-partition disk monitoring with usage percentages
- **Network I/O** - Real-time network throughput (upload/download speeds)
- **Process Monitoring** - Top memory-consuming processes with CPU usage
- **System Uptime** - Days, hours, and minutes since boot

### Ollama Integration
- **Model Management** - View all installed Ollama models with size and parameter info
- **Load/Unload** - Dynamic model loading and unloading from memory
- **Download Models** - Pull new models directly from the dashboard
- **Delete Models** - Remove unwanted models with confirmation
- **Running Status** - Visual indication of currently loaded models
- **Activity Console** - Real-time logging of model operations

### UI Features
- **Circular Gauges** - Clean visualization with yellow (70%) and red (90%) threshold indicators
- **Live Updates** - Server-Sent Events (SSE) for real-time metrics streaming (1s interval)
- **Responsive Grid** - Auto-fitting card layout that adapts to screen size
- **Dark Theme** - Professional dark interface optimized for 24/7 monitoring
- **Modal Interface** - Dedicated model management dialog with console output

## Prerequisites

- **Node.js** v25.6.0+ (via nvm recommended)
- **NVIDIA GPU** with nvidia-smi installed
- **Ollama** (optional) - For LLM model management features
- **Linux** - Tested on Ubuntu 24.04

## Installation

```bash
# Clone the repository
git clone https://github.com/Viroscope/dgx-spark-status.git
cd dgx-spark-status

# Install dependencies
npm install

# Start development server
npm run dev
```

## Usage

### Development Server
```bash
npm run dev
```
Dashboard will be available at `http://localhost:9000`

The dev server includes:
- SSE endpoint at `/api/metrics`
- Ollama management API at `/api/ollama`
- Hot module reloading via Vite

### Production Build
```bash
npm run build
node server.js
```

### Start Script
```bash
./start.sh
```
Convenient wrapper that handles Node version switching via nvm.

## Configuration

### Update Interval
Modify `UPDATE_INTERVAL` in `dev-server.js` or `src/routes/api/metrics/+server.js`:
```javascript
const UPDATE_INTERVAL = 1000; // milliseconds
```

### Ollama API Endpoint
Change `OLLAMA_API` if running Ollama on different host/port:
```javascript
const OLLAMA_API = 'http://localhost:11434';
```

### Port Configuration
Development server runs on port 9000 by default. Change in `dev-server.js`:
```javascript
server: {
  host: '0.0.0.0',
  port: 9000
}
```

## Technology Stack

- **SvelteKit 2.50.2** - Full-stack framework with SSR
- **Svelte 5.43.8** - Reactive UI framework with modern runes
- **Vite 7.2.4** - Fast build tool and dev server
- **systeminformation** - Cross-platform system metrics library
- **nvidia-smi** - Direct GPU querying
- **Express** - Middleware for SSE handling
- **Server-Sent Events** - Real-time streaming protocol

## Project Structure

```
dgx-spark-status/
├── src/
│   ├── lib/
│   │   ├── SystemMetrics.svelte  # Main dashboard component
│   │   ├── Gauge.svelte          # Circular gauge component
│   │   └── websocket.js          # SSE client handler
│   └── routes/
│       └── api/
│           ├── metrics/+server.js  # SSE metrics endpoint
│           └── ollama/+server.js   # Ollama management API
├── dev-server.js           # Development server with SSE
├── server.js              # Production server
├── start.sh              # Startup script with nvm
└── package.json
```

## API Endpoints

### GET /api/metrics
Server-Sent Events stream providing real-time system metrics every second.

### POST /api/ollama
Ollama model management endpoint.

**Actions:**
- `pull` - Download a model
- `delete` - Remove a model
- `load` - Load model into memory
- `unload` - Unload model from memory

## License

MIT

## Author

Phanes @ OnticEntia.ai
