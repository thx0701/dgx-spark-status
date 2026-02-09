import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const OLLAMA_API = 'http://localhost:11434';

export async function POST({ request }) {
  try {
    const { action, model } = await request.json();

    if (action === 'pull') {
      // Pull/download a new model
      try {
        const { stdout, stderr } = await execAsync(`ollama pull ${model}`, {
          timeout: 600000 // 10 minute timeout
        });

        return new Response(JSON.stringify({
          success: true,
          message: `Model ${model} downloaded successfully`,
          output: stdout
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: `Failed to pull model: ${error.message}`
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } else if (action === 'delete') {
      // Delete/remove a model
      try {
        const { stdout, stderr } = await execAsync(`ollama rm ${model}`);

        return new Response(JSON.stringify({
          success: true,
          message: `Model ${model} deleted successfully`,
          output: stdout
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: `Failed to delete model: ${error.message}`
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } else if (action === 'load') {
      // Load a model by making a generate request with no prompt
      const response = await fetch(`${OLLAMA_API}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          prompt: '',
          keep_alive: '5m'
        })
      });

      if (!response.ok) {
        return new Response(JSON.stringify({ error: 'Failed to load model' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Consume the streaming response
      const reader = response.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      return new Response(JSON.stringify({ success: true, message: `Model ${model} loaded` }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } else if (action === 'unload') {
      // Unload a model by setting keep_alive to 0
      const response = await fetch(`${OLLAMA_API}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          prompt: '',
          keep_alive: 0
        })
      });

      if (!response.ok) {
        return new Response(JSON.stringify({ error: 'Failed to unload model' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Consume the streaming response
      const reader = response.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      return new Response(JSON.stringify({ success: true, message: `Model ${model} unloaded` }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({ error: 'Invalid action' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    console.error('Ollama API error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
