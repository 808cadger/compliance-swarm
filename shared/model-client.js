// shared/model-client.js
// Settings (localStorage, versioned + migrated), model-policy.json loading
// and safety-tripwire enforcement, config resolution, and dispatch to
// provider modules. No secrets ever leave the browser except a user's own
// pasted API key, sent directly to that provider's endpoint.

import { call as callAnthropic } from './providers/anthropic.js';
import { call as callOllama } from './providers/ollama.js';

const SETTINGS_KEY = 'compliance-swarm-settings';
const MODEL_POLICY_PATH = '../config/model-policy.json';

const FALLBACK_MODEL_POLICY = {
  version: 1,
  defaults: { provider: 'anthropic', model: 'claude-sonnet-5', maxTokens: 400 },
  agents: {},
  policy: {
    allowedProviders: ['anthropic', 'ollama'],
    allowCloudFallback: false,
    requireHumanApproval: true,
    allowExecutedActions: false,
    payroll: { modelMayCalculatePay: false, cloudFallbackAllowed: false }
  }
};

const DEFAULT_CLOUD_MODEL = 'claude-sonnet-5';
const DEFAULT_LOCAL_MODEL = 'llama3';

function freshSettings() {
  return {
    schemaVersion: 2,
    mode: 'repo-defaults',
    cloud: { apiKey: '', endpoint: 'https://api.anthropic.com/v1/messages', model: null },
    local: { endpoint: 'http://localhost:11434/api/chat', model: null },
    agentOverrides: {}
  };
}

export function loadSettings() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  } catch (e) {
    raw = null;
  }
  if (!raw) return freshSettings();
  if (raw.schemaVersion === 2) return raw;
  // Pre-v2 shape (predates this feature, or the unreleased intermediate
  // branch shape) — migrate, preserving an explicit prior 'local' choice as
  // force-local; everything else defaults to force-cloud so behavior
  // doesn't silently change out from under them.
  const migrated = freshSettings();
  migrated.mode = raw.mode === 'local' ? 'force-local' : 'force-cloud';
  if (raw.apiKey) migrated.cloud.apiKey = raw.apiKey;
  if (raw.localEndpoint) migrated.local.endpoint = raw.localEndpoint;
  if (raw.localModel) migrated.local.model = raw.localModel;
  saveSettings(migrated);
  return migrated;
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function assertPolicyInvariants(policy) {
  if (policy.requireHumanApproval !== true) {
    throw new Error('model-policy.json violates policy invariants: requireHumanApproval must be true');
  }
  if (policy.allowExecutedActions !== false) {
    throw new Error('model-policy.json violates policy invariants: allowExecutedActions must be false');
  }
  if (policy.allowCloudFallback !== false) {
    throw new Error('model-policy.json violates policy invariants: allowCloudFallback must be false');
  }
  if (!policy.payroll || policy.payroll.cloudFallbackAllowed !== false) {
    throw new Error('model-policy.json violates policy invariants: policy.payroll.cloudFallbackAllowed must be false');
  }
  if (policy.payroll.modelMayCalculatePay !== false) {
    throw new Error('model-policy.json violates policy invariants: policy.payroll.modelMayCalculatePay must be false');
  }
}

let modelPolicyPromise = null;

export function loadModelPolicy() {
  if (!modelPolicyPromise) {
    modelPolicyPromise = fetch(MODEL_POLICY_PATH)
      .then(res => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .catch(err => {
        console.warn('model-policy.json failed to load, using built-in defaults:', err.message);
        return FALLBACK_MODEL_POLICY;
      })
      .then(policy => {
        assertPolicyInvariants(policy.policy);
        return policy;
      });
  }
  return modelPolicyPromise;
}

function assertAllowed(provider, modelPolicy) {
  if (!modelPolicy.policy.allowedProviders.includes(provider)) {
    throw new Error(`POLICY_BLOCKED_PROVIDER: ${provider}`);
  }
}

export function resolveModelConfig(agentId, modelPolicy, settings) {
  const base = {
    ...modelPolicy.defaults,
    ...(modelPolicy.agents?.[agentId] || {})
  };

  if (settings.mode === 'force-cloud') {
    assertAllowed('anthropic', modelPolicy);
    return {
      ...base,
      provider: 'anthropic',
      endpoint: settings.cloud.endpoint,
      model: settings.cloud.model || (base.provider === 'anthropic' ? base.model : DEFAULT_CLOUD_MODEL),
      apiKey: settings.cloud.apiKey
    };
  }

  if (settings.mode === 'force-local') {
    assertAllowed('ollama', modelPolicy);
    return {
      ...base,
      provider: 'ollama',
      endpoint: settings.local.endpoint,
      model: settings.local.model || (base.provider === 'ollama' ? base.model : DEFAULT_LOCAL_MODEL)
    };
  }

  if (settings.mode === 'custom' && settings.agentOverrides?.[agentId]) {
    const merged = { ...base, ...settings.agentOverrides[agentId] };
    assertAllowed(merged.provider, modelPolicy);
    return {
      ...merged,
      apiKey: settings.cloud.apiKey,
      endpoint:
        merged.provider === 'ollama'
          ? (merged.endpoint || settings.local.endpoint)
          : (merged.endpoint || settings.cloud.endpoint)
    };
  }

  // repo-defaults
  assertAllowed(base.provider, modelPolicy);
  return {
    ...base,
    apiKey: settings.cloud.apiKey,
    endpoint:
      base.provider === 'ollama'
        ? (base.endpoint || settings.local.endpoint)
        : (base.endpoint || settings.cloud.endpoint)
  };
}

export async function callModel(config, messages) {
  let result;
  if (config.provider === 'anthropic') {
    result = await callAnthropic(config, messages);
  } else if (config.provider === 'ollama') {
    result = await callOllama(config, messages);
  } else {
    throw new Error(`UNKNOWN_PROVIDER: ${config.provider}`);
  }
  return {
    text: result.text,
    provider: config.provider,
    model: config.model,
    usage: result.usage
  };
}

export function renderSettingsPanel(container, modelPolicy) {
  const s = loadSettings();
  const allowed = modelPolicy.policy.allowedProviders;
  container.innerHTML = `
    <fieldset class="settings-panel">
      <legend>Model Settings</legend>
      <label><input type="radio" name="mode" value="repo-defaults" ${s.mode === 'repo-defaults' ? 'checked' : ''}> Repo Defaults (recommended)</label>
      ${allowed.includes('anthropic') ? `<label><input type="radio" name="mode" value="force-cloud" ${s.mode === 'force-cloud' ? 'checked' : ''}> Force Cloud (Anthropic)</label>` : ''}
      ${allowed.includes('ollama') ? `<label><input type="radio" name="mode" value="force-local" ${s.mode === 'force-local' ? 'checked' : ''}> Force Local (Ollama)</label>` : ''}
      <div class="cloud-fields" style="${s.mode === 'force-local' ? 'display:none' : ''}">
        <label>API Key <input type="password" id="apiKeyInput" value="${s.cloud.apiKey}" placeholder="sk-ant-..."></label>
        <label>Model <input type="text" id="cloudModelInput" value="${s.cloud.model || ''}" placeholder="(repo default)"></label>
      </div>
      <div class="local-fields" style="${s.mode === 'force-local' ? '' : 'display:none'}">
        <label>Endpoint <input type="text" id="endpointInput" value="${s.local.endpoint}"></label>
        <label>Model <input type="text" id="localModelInput" value="${s.local.model || ''}" placeholder="(repo default)"></label>
      </div>
      <p class="settings-note">Stored only in this browser's localStorage. Repo Defaults resolves each agent's provider/model from config/model-policy.json.</p>
    </fieldset>
  `;
  container.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', e => {
    const settings = loadSettings();
    settings.mode = e.target.value;
    saveSettings(settings);
    renderSettingsPanel(container, modelPolicy);
  }));
  const apiKeyInput = container.querySelector('#apiKeyInput');
  if (apiKeyInput) apiKeyInput.addEventListener('change', e => { const st = loadSettings(); st.cloud.apiKey = e.target.value; saveSettings(st); });
  const cloudModelInput = container.querySelector('#cloudModelInput');
  if (cloudModelInput) cloudModelInput.addEventListener('change', e => { const st = loadSettings(); st.cloud.model = e.target.value || null; saveSettings(st); });
  const endpointInput = container.querySelector('#endpointInput');
  if (endpointInput) endpointInput.addEventListener('change', e => { const st = loadSettings(); st.local.endpoint = e.target.value; saveSettings(st); });
  const localModelInput = container.querySelector('#localModelInput');
  if (localModelInput) localModelInput.addEventListener('change', e => { const st = loadSettings(); st.local.model = e.target.value || null; saveSettings(st); });
}

export function renderModelError(container, err) {
  if (err.message === 'NO_KEY') {
    container.textContent = 'Add an API key in Settings to use this feature.';
  } else if (err.message === 'NO_ENDPOINT') {
    container.textContent = 'Set a Local endpoint in Settings to use this feature.';
  } else if (err.message.startsWith('POLICY_BLOCKED_PROVIDER')) {
    const provider = err.message.split(': ')[1] || '';
    container.textContent = `The "${provider}" provider is disabled by policy (config/model-policy.json). Choose a different mode in Settings.`;
  } else {
    container.textContent = 'Model call failed: ' + err.message;
  }
  container.classList.add('model-error');
}

export function renderResultBadge(result, { templateVersion } = {}) {
  const providerLabel = result.provider === 'ollama' ? 'Local' : 'Cloud';
  let html = `<span class="badge">${providerLabel} · ${result.model}</span>`;
  if (templateVersion) {
    html += ` <span class="badge">${templateVersion}</span>`;
  }
  return html;
}
