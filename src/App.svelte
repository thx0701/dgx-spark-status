<script>
  import svelteLogo from './assets/svelte.svg'
  import viteLogo from '/vite.svg'
  import Counter from './lib/Counter.svelte'

  // Get current hostname and port
  const hostname = window.location.hostname;
  const port = window.location.port;
</script>

<main>
  <div>
    <a href="https://vite.dev" target="_blank" rel="noreferrer">
      <img src={viteLogo} class="logo" alt="Vite Logo" />
    </a>
    <a href="https://svelte.dev" target="_blank" rel="noreferrer">
      <img src={svelteLogo} class="logo svelte" alt="Svelte Logo" />
    </a>
  </div>
  <h1>Vite + Svelte</h1>

  <div class="network-info">
    <h2>Network Information</h2>
    <p>Server running on: <strong>{hostname}:{port}</strong></p>
    <p>Accessible on local network (192.168.1.*)</p>
  </div>

  <div class="card">
    <Counter />
  </div>

  <p>
    Check out <a href="https://github.com/sveltejs/kit#readme" target="_blank" rel="noreferrer">SvelteKit</a>, the official Svelte app framework powered by Vite!
  </p>

  <p class="read-the-docs">
    Click on the Vite and Svelte logos to learn more
  </p>
</main>

<style>
  .logo {
    height: 6em;
    padding: 1.5em;
    will-change: filter;
    transition: filter 300ms;
  }
  .logo:hover {
    filter: drop-shadow(0 0 2em #646cffaa);
  }
  .logo.svelte:hover {
    filter: drop-shadow(0 0 2em #ff3e00aa);
  }
  .network-info {
    margin: 2em 0;
    padding: 1.5em;
    background: #1a1a1a;
    border-radius: 8px;
    border: 1px solid #333;
  }
  .network-info h2 {
    margin-top: 0;
    color: #ff3e00;
  }
  .network-info p {
    margin: 0.5em 0;
  }
  .network-info strong {
    color: #646cff;
  }
  .read-the-docs {
    color: #888;
  }
</style>
