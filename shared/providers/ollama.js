// shared/providers/ollama.js
// Sends one chat-style request to an Ollama-compatible /api/chat endpoint
// and normalizes the response. Knows nothing about Settings, localStorage,
// or policy.

export async function call(config, messages) {
  if (!config.endpoint) throw new Error('NO_ENDPOINT');
  const body = {
    model: config.model,
    messages,
    stream: false,
    options: { num_predict: config.maxTokens }
  };
  if (config.temperature !== undefined) body.options.temperature = config.temperature;
  const res = await fetch(config.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Local call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    text: data.message ? data.message.content : JSON.stringify(data),
    usage: {
      inputTokens: data.prompt_eval_count ?? null,
      outputTokens: data.eval_count ?? null
    }
  };
}
