let profiles = [];
let selectedId = null;
let availableModelsByProvider = {};
const $ = id => document.getElementById(id);

const DEFAULT_PROVIDER = 'groq';
const DEFAULT_MODELS = {
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o-mini',
  claude: 'claude-3-5-haiku-latest'
};
const FALLBACK_MODELS = {
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  claude: ['claude-3-5-haiku-latest', 'claude-sonnet-4-5', 'claude-haiku-4-5']
};
const PROVIDER_LABELS = { groq: 'Groq', openai: 'OpenAI', claude: 'Claude' };

function requireElement(id) {
  const el = $(id);
  if (!el) throw new Error(`Missing element #${id}. Reload the extension and reopen Options.`);
  return el;
}

function defaultProfiles() {
  return [
    {
      id: crypto.randomUUID(),
      name: 'Generic WhatsApp reply',
      matchTexts: [],
      matchText: '',
      matchContacts: [],
      isGeneric: true,
      provider: 'groq',
      model: DEFAULT_MODELS.groq,
      systemPrompt: 'Draft a concise, polite WhatsApp reply. Ask for missing information only if needed. Do not invent facts. Keep the tone natural and practical. Draft only; do not send.',
      markdown: '# General style\n\nUse plain English. Keep it short. Prefer a helpful, practical answer.\n'
    }
  ];
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => showStatus(`Options error: ${err.message || err}`, true));
});

async function init() {
  [
    'groqApiKey', 'openaiApiKey', 'claudeApiKey', 'refreshModels', 'modelStatus', 'myNames',
    'profiles', 'newProfile', 'deleteProfile', 'name', 'isGeneric', 'matchTexts', 'newMatchText', 'addMatchText', 'removeMatchText', 'matchContacts', 'newMatchContact', 'addMatchContact', 'removeMatchContact', 'profileProvider', 'profileModel',
    'systemPrompt', 'markdown', 'debugEnabled', 'reloadDebug', 'clearDebug', 'debugHistory', 'save', 'status'
  ].forEach(requireElement);

  bindEvents();

  const stored = await chrome.storage.local.get([
    'apiKey', 'apiKeys', 'provider', 'model', 'profiles', 'availableModels', 'availableModelsByProvider', 'selectedProfileId', 'debugEnabled', 'myNames'
  ]);

  const apiKeys = stored.apiKeys || {};
  $('groqApiKey').value = apiKeys.groq || stored.apiKey || '';
  $('openaiApiKey').value = apiKeys.openai || '';
  $('claudeApiKey').value = apiKeys.claude || '';
  $('debugEnabled').checked = stored.debugEnabled !== false;
  $('myNames').value = Array.isArray(stored.myNames) ? stored.myNames.join('\n') : 'You';

  availableModelsByProvider = normalizeAvailableModels(stored.availableModelsByProvider || stored.availableModels || {});

  profiles = Array.isArray(stored.profiles) && stored.profiles.length ? stored.profiles.map(migrateProfile) : defaultProfiles();
  selectedId = stored.selectedProfileId && profiles.some(p => p.id === stored.selectedProfileId)
    ? stored.selectedProfileId
    : profiles[0]?.id || null;

  renderProfileSelect();
  loadSelectedProfile();
  await loadDebugHistory();
}

function bindEvents() {
  $('profiles').addEventListener('change', () => {
    saveFieldsToSelected();
    selectedId = $('profiles').value;
    loadSelectedProfile();
  });

  $('profileProvider').addEventListener('change', () => {
    renderModelSelectForProvider($('profileProvider').value);
  });

  $('addMatchText').addEventListener('click', () => {
    const value = $('newMatchText').value.trim();
    if (!value) return;
    addMatchTextToCurrent(value);
    $('newMatchText').value = '';
  });

  $('newMatchText').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('addMatchText').click();
    }
  });

  $('removeMatchText').addEventListener('click', () => {
    const p = currentProfile();
    if (!p) return;
    const selected = Array.from($('matchTexts').selectedOptions).map(opt => opt.value);
    p.matchTexts = (p.matchTexts || []).filter(value => !selected.includes(value));
    renderMatchTexts(p);
  });

  $('addMatchContact').addEventListener('click', () => {
    const value = $('newMatchContact').value.trim();
    if (!value) return;
    addMatchContactToCurrent(value);
    $('newMatchContact').value = '';
  });

  $('newMatchContact').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('addMatchContact').click();
    }
  });

  $('removeMatchContact').addEventListener('click', () => {
    const p = currentProfile();
    if (!p) return;
    const selected = Array.from($('matchContacts').selectedOptions).map(opt => opt.value);
    p.matchContacts = (p.matchContacts || []).filter(value => !selected.includes(value));
    renderMatchContacts(p);
  });

  $('newProfile').addEventListener('click', () => {
    saveFieldsToSelected();
    const p = {
      id: crypto.randomUUID(),
      name: 'New profile',
      matchTexts: [],
      matchText: '',
      matchContacts: [],
      isGeneric: false,
      provider: 'groq',
      model: DEFAULT_MODELS.groq,
      systemPrompt: 'Draft a concise, polite WhatsApp reply. Do not invent facts. Do not send it.',
      markdown: '# Context\n\n'
    };
    profiles.push(p);
    selectedId = p.id;
    renderProfileSelect();
    loadSelectedProfile();
  });

  $('deleteProfile').addEventListener('click', () => {
    if (!selectedId) return;
    profiles = profiles.filter(p => p.id !== selectedId);
    if (!profiles.length) profiles = defaultProfiles();
    selectedId = profiles[0]?.id || null;
    renderProfileSelect();
    loadSelectedProfile();
  });

  $('refreshModels').addEventListener('click', () => {
    refreshAllModels().catch(err => {
      showModelStatus(`Could not load models: ${err.message || err}`, true);
      showStatus(`Model refresh failed: ${err.message || err}`, true);
    });
  });

  $('save').addEventListener('click', async () => {
    try {
      saveFieldsToSelected();
      const apiKeys = collectApiKeys();
      await chrome.storage.local.set({
        selectedProfileId: selectedId,
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODELS.groq,
        apiKey: apiKeys.groq || '',
        apiKeys,
        availableModelsByProvider,
        profiles,
        debugEnabled: $('debugEnabled').checked,
        myNames: $('myNames').value.split(/\n|,/).map(v => v.trim()).filter(Boolean)
      });
      renderProfileSelect();
      showStatus('Saved.');
    } catch (err) {
      showStatus(`Save failed: ${err.message || err}`, true);
    }
  });

  $('reloadDebug').addEventListener('click', () => loadDebugHistory());
  $('clearDebug').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_DEBUG_HISTORY' });
    await loadDebugHistory();
    showStatus('Debug history cleared.');
  });
}

function collectApiKeys() {
  return {
    groq: $('groqApiKey').value.trim(),
    openai: $('openaiApiKey').value.trim(),
    claude: $('claudeApiKey').value.trim()
  };
}

function showStatus(text, isError = false) {
  const status = $('status');
  if (!status) return console.error(text);
  status.textContent = text;
  status.className = isError ? 'error' : '';
  if (!isError) setTimeout(() => { status.textContent = ''; status.className = ''; }, 1800);
}

function showModelStatus(text, isError = false) {
  const status = $('modelStatus');
  if (!status) return console.error(text);
  status.textContent = text;
  status.className = isError ? 'note error' : 'note';
}

function normalizeAvailableModels(value) {
  const result = {};
  if (Array.isArray(value)) result.groq = value;
  else result.groq = value?.groq || [];
  result.openai = value?.openai || [];
  result.claude = value?.claude || [];
  for (const provider of Object.keys(FALLBACK_MODELS)) {
    result[provider] = normalizeModelList([...(result[provider] || []), ...FALLBACK_MODELS[provider]], provider);
  }
  return result;
}

function normalizeModelList(models, provider) {
  const ids = (models || [])
    .map(m => typeof m === 'string' ? m : m?.id)
    .filter(Boolean)
    .filter((id, index, arr) => arr.indexOf(id) === index)
    .sort((a, b) => a.localeCompare(b));
  return ids.length ? ids : FALLBACK_MODELS[provider];
}

function renderModelSelectForProvider(provider, selectedModel = null) {
  const select = $('profileModel');
  const models = normalizeModelList([...(availableModelsByProvider[provider] || []), selectedModel, DEFAULT_MODELS[provider]].filter(Boolean), provider);
  availableModelsByProvider[provider] = models;
  select.innerHTML = '';
  models.forEach(modelId => {
    const opt = document.createElement('option');
    opt.value = modelId;
    opt.textContent = `${PROVIDER_LABELS[provider]} - ${modelId}`;
    select.appendChild(opt);
  });
  select.value = selectedModel && models.includes(selectedModel) ? selectedModel : DEFAULT_MODELS[provider];
}

async function refreshAllModels() {
  const apiKeys = collectApiKeys();
  const summary = [];
  for (const provider of ['groq', 'openai', 'claude']) {
    if (!apiKeys[provider]) {
      summary.push(`${PROVIDER_LABELS[provider]}: no key`);
      continue;
    }
    try {
      const models = await fetchModels(provider, apiKeys[provider]);
      availableModelsByProvider[provider] = normalizeModelList(models, provider);
      summary.push(`${PROVIDER_LABELS[provider]}: ${availableModelsByProvider[provider].length}`);
    } catch (err) {
      summary.push(`${PROVIDER_LABELS[provider]}: failed (${err.message || err})`);
    }
  }
  saveFieldsToSelected();
  renderModelSelectForProvider(currentProfile()?.provider || 'groq', currentProfile()?.model);
  await chrome.storage.local.set({ availableModelsByProvider, apiKeys });
  showModelStatus(`Model refresh complete. ${summary.join(' · ')}`);
  showStatus('Models refreshed.');
}

async function fetchModels(provider, apiKey) {
  if (provider === 'groq') return fetchOpenAICompatibleModels('https://api.groq.com/openai/v1/models', apiKey, 'Groq');
  if (provider === 'openai') return fetchOpenAICompatibleModels('https://api.openai.com/v1/models', apiKey, 'OpenAI');
  if (provider === 'claude') return fetchClaudeModels(apiKey);
  throw new Error(`Unknown provider: ${provider}`);
}

async function fetchOpenAICompatibleModels(url, apiKey, label) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!response.ok) throw new Error(json?.error?.message || text || `${label} error ${response.status}`);
  return json?.data || [];
}

async function fetchClaudeModels(apiKey) {
  const response = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json'
    }
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!response.ok) throw new Error(json?.error?.message || text || `Claude error ${response.status}`);
  return json?.data || [];
}

function renderProfileSelect() {
  const select = $('profiles');
  select.innerHTML = '';
  profiles.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || '(unnamed)';
    select.appendChild(opt);
  });
  if (selectedId) select.value = selectedId;
}

function currentProfile() {
  return profiles.find(p => p.id === selectedId);
}

function migrateProfile(p) {
  const provider = p.provider || 'groq';
  const oldMatch = p.matchText ?? p.urlMatch ?? '';
  const matchTexts = Array.isArray(p.matchTexts)
    ? p.matchTexts.map(String).map(v => v.trim()).filter(Boolean)
    : (oldMatch ? [String(oldMatch).trim()] : []);
  const matchContacts = Array.isArray(p.matchContacts) ? p.matchContacts.map(String).map(v => v.trim()).filter(Boolean) : [];
  const isGeneric = typeof p.isGeneric === 'boolean' ? p.isGeneric : (!matchTexts.length && !matchContacts.length);
  return {
    ...p,
    matchTexts,
    matchText: matchTexts[0] || '',
    matchContacts,
    isGeneric,
    provider,
    model: p.model || DEFAULT_MODELS[provider] || DEFAULT_MODELS.groq
  };
}

function loadSelectedProfile() {
  const p = currentProfile();
  const provider = p?.provider || 'groq';
  $('name').value = p?.name || '';
  $('isGeneric').checked = !!p?.isGeneric;
  renderMatchTexts(p);
  renderMatchContacts(p);
  $('profileProvider').value = provider;
  renderModelSelectForProvider(provider, p?.model || DEFAULT_MODELS[provider]);
  $('systemPrompt').value = p?.systemPrompt || '';
  $('markdown').value = p?.markdown || '';
}

function saveFieldsToSelected() {
  let p = currentProfile();
  if (!p) {
    p = { id: crypto.randomUUID(), name: 'New profile', matchTexts: [], matchText: '', matchContacts: [], isGeneric: false, provider: 'groq', model: DEFAULT_MODELS.groq, systemPrompt: '', markdown: '' };
    profiles.push(p);
    selectedId = p.id;
  }
  p.name = $('name').value.trim() || 'Unnamed profile';
  p.isGeneric = $('isGeneric').checked;
  p.matchTexts = currentMatchTextsFromDom();
  p.matchText = p.matchTexts[0] || '';
  p.matchContacts = currentMatchContactsFromDom();
  p.provider = $('profileProvider').value || 'groq';
  p.model = $('profileModel').value || DEFAULT_MODELS[p.provider];
  p.systemPrompt = $('systemPrompt').value;
  p.markdown = $('markdown').value;
}

function renderMatchTexts(profile) {
  const select = $('matchTexts');
  select.innerHTML = '';
  const values = (profile?.matchTexts || []).map(String).filter(Boolean);
  values.forEach(value => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  });
}

function currentMatchTextsFromDom() {
  return Array.from($('matchTexts').options)
    .map(opt => opt.value.trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.findIndex(v => v.toLowerCase() === value.toLowerCase()) === index);
}

function addMatchTextToCurrent(value) {
  const p = currentProfile();
  if (!p) return;
  const next = [...(p.matchTexts || []), value]
    .map(v => String(v).trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i);
  p.matchTexts = next;
  p.matchText = next[0] || '';
  renderMatchTexts(p);
}

function renderMatchContacts(profile) {
  const select = $('matchContacts');
  select.innerHTML = '';
  const values = (profile?.matchContacts || []).map(String).filter(Boolean);
  values.forEach(value => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  });
}

function currentMatchContactsFromDom() {
  return Array.from($('matchContacts').options)
    .map(opt => opt.value.trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.findIndex(v => v.toLowerCase() === value.toLowerCase()) === index);
}

function addMatchContactToCurrent(value) {
  const p = currentProfile();
  if (!p) return;
  const next = [...(p.matchContacts || []), value]
    .map(v => String(v).trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i);
  p.matchContacts = next;
  renderMatchContacts(p);
}

async function loadDebugHistory() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_DEBUG_HISTORY' });
  const history = response?.history || [];
  const root = $('debugHistory');
  root.innerHTML = '';
  if (!history.length) {
    root.innerHTML = '<p class="note">No debug entries yet. Generate a draft from WhatsApp, then reload this section.</p>';
    return;
  }
  history.forEach(entry => root.appendChild(renderDebugEntry(entry)));
}

function renderDebugEntry(entry) {
  const details = document.createElement('details');
  details.className = entry.ok ? 'debug-entry' : 'debug-entry error-entry';

  const summary = document.createElement('summary');
  const label = document.createElement('span');
  label.textContent = `${new Date(entry.createdAt).toLocaleString()} · ${entry.profileName || 'Profile'} · ${PROVIDER_LABELS[entry.provider] || entry.provider} - ${entry.model} · ${entry.ok ? 'OK' : 'ERROR'}`;

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'debug-copy';
  copy.textContent = 'Copy JSON';
  copy.title = 'Copy this debug entry as JSON for troubleshooting';
  copy.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
      showStatus('Debug JSON copied.');
    } catch (err) {
      showStatus(`Copy failed: ${err.message || err}`, true);
    }
  });

  summary.append(label, copy);
  details.appendChild(summary);

  const fields = [
    ['Profile used', `${entry.profileName || ''} (${entry.profileId || ''}) · ${PROVIDER_LABELS[entry.provider] || entry.provider || ''} - ${entry.model || ''}`],
    ['Chat title', entry.chatTitle],
    ['Selected message', entry.selectedMessage],
    ['Recent messages', entry.recentMessages],
    ['System prompt sent', entry.system],
    ['User prompt sent', entry.user],
    ['Draft / reply', entry.draft],
    ['Error', entry.error]
  ];
  for (const [label, value] of fields) {
    if (!value) continue;
    const h = document.createElement('h3');
    h.textContent = label;
    const pre = document.createElement('pre');
    pre.textContent = value;
    details.appendChild(h);
    details.appendChild(pre);
  }
  return details;
}
