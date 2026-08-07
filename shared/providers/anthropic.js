// shared/providers/anthropic.js
// Sends one chat-style request to the Anthropic Messages API and normalizes
// the response. Knows nothing about Settings, localStorage, or policy.

export async function call(config, messages) {
  if (!config.apiKey) throw new Error('NO_KEY');
  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages
  };
  if (config.temperature !== undefined) body.temperature = config.temperature;
  const res = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Cloud call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    text: data.content.map(c => c.text || '').join(''),
    usage: {
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null
    }
  };
}
