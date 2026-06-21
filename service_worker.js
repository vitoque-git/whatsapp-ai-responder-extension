const DEFAULT_PROVIDER = 'groq';
const DEFAULT_MODELS = {
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o-mini',
  claude: 'claude-3-5-haiku-latest'
};
const MAX_DEBUG_HISTORY = 50;

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['profiles', 'provider', 'model', 'apiKeys', 'debugEnabled', 'myNames']);
  if (!existing.provider) await chrome.storage.local.set({ provider: DEFAULT_PROVIDER });
  if (!existing.model) await chrome.storage.local.set({ model: DEFAULT_MODELS.groq });
  if (!existing.apiKeys) await chrome.storage.local.set({ apiKeys: {} });
  if (typeof existing.debugEnabled !== 'boolean') await chrome.storage.local.set({ debugEnabled: true });
  if (!Array.isArray(existing.myNames)) await chrome.storage.local.set({ myNames: ['You'] });
  if (!existing.profiles) {
    await chrome.storage.local.set({ profiles: defaultProfiles() });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'AI_CHAT') {
    callAIProvider(message.payload)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message?.type === 'GET_MATCHING_PROFILES') {
    getMatchingProfiles(message.payload || {})
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message?.type === 'CREATE_PROFILE_FOR_CHAT') {
    createProfileForChat(message.payload || {})
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message?.type === 'AI_DRAFT_REPLY') {
    draftReplyFromStoredProfile(message.payload || {})
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message?.type === 'GET_DEBUG_HISTORY') {
    chrome.storage.local.get(['debugHistory']).then(({ debugHistory = [] }) => sendResponse({ ok: true, history: debugHistory }));
    return true;
  }

  if (message?.type === 'CLEAR_DEBUG_HISTORY') {
    chrome.storage.local.set({ debugHistory: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

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

async function draftReplyFromStoredProfile({ chatTitle = '', contactName = '', profileId = '', selectedMessage = '', recentMessages = '' }) {
  const { profiles = [], myNames = ['You'] } = await chrome.storage.local.get(['profiles', 'myNames']);
  const list = migrateProfiles(profiles);
  const profile = profileId ? list.find(p => p.id === profileId) : pickProfile(list, chatTitle, contactName);
  if (!profile) throw new Error('No profile found. Add one in extension Options.');

  const system = [
    profile.systemPrompt || 'Draft a concise WhatsApp reply.',
    'You are drafting for WhatsApp. Return only the message text, with no explanation and no quotation marks.',
    'Use the knowledge markdown when it contains relevant facts. Do not ignore it. If the answer is not in the markdown or chat context, say so briefly instead of inventing.',
    `You are drafting as: ${Array.isArray(myNames) && myNames.length ? myNames.join(', ') : 'the WhatsApp user'}. Do not answer as another participant. If recent context includes messages from you, use them as context only, not as the message to answer.`,
    'Do not send the message.',
    `\nKnowledge markdown:\n${profile.markdown || ''}`
  ].join('\n\n');

  const user = [
    `WhatsApp chat title: ${chatTitle || ''}`,
    `WhatsApp contact/direct chat name: ${contactName || ''}`,
    `My name(s): ${Array.isArray(myNames) ? myNames.join(', ') : ''}`,
    `Profile: ${profile.name || ''}`,
    'Task: Draft a direct reply to the selected WhatsApp message. Use the chat context only when useful.',
    'Selected message:',
    selectedMessage,
    recentMessages ? `\nRecent visible chat context:\n${recentMessages}` : ''
  ].join('\n\n');

  const provider = profile.provider || DEFAULT_PROVIDER;
  const model = profile.model || DEFAULT_MODELS[provider] || DEFAULT_MODELS.groq;
  const debugBase = {
    chatTitle,
    contactName,
    myNames,
    profileId: profile.id,
    profileName: profile.name || '',
    provider,
    model,
    selectedMessage,
    recentMessages,
    system,
    user
  };

  try {
    const result = await callAIProvider({ provider, model, system, user, temperature: 0.3 });
    await addDebugEntry({ ...debugBase, ok: true, draft: result.draft });
    return result;
  } catch (err) {
    await addDebugEntry({ ...debugBase, ok: false, error: err.message || String(err) });
    throw err;
  }
}

async function getMatchingProfiles(payload = '') {
  const chatTitle = typeof payload === 'string' ? payload : (payload?.chatTitle || '');
  const contactName = typeof payload === 'string' ? '' : (payload?.contactName || '');
  const { profiles = [] } = await chrome.storage.local.get(['profiles']);
  const matches = matchingProfiles(profiles, chatTitle, contactName)
    .map(p => ({ id: p.id, name: p.name || 'Unnamed profile' }));
  return { ok: true, profiles: matches };
}

async function createProfileForChat({ chatTitle = '' }) {
  const title = String(chatTitle || '').trim();
  if (!title) throw new Error('Could not detect the active WhatsApp chat title.');

  const stored = await chrome.storage.local.get(['profiles']);
  const profiles = migrateProfiles(stored.profiles || []);
  const existing = profiles.find(p => (p.matchTexts || []).some(t => String(t || '').toLowerCase() === title.toLowerCase()));
  if (existing) return { ok: true, profile: existing, created: false };

  const profile = {
    id: crypto.randomUUID(),
    name: title,
    matchTexts: [title],
    matchText: title,
    matchContacts: [],
    isGeneric: false,
    provider: 'groq',
    model: DEFAULT_MODELS.groq,
    systemPrompt: 'Draft a concise, polite WhatsApp reply for this chat. Ask for missing information only if needed. Do not invent facts. Keep the tone natural and practical. Draft only; do not send.',
    markdown: '# Chat context\n\nAdd rules, facts, style notes, and reusable answers for this WhatsApp chat here.\n'
  };
  profiles.push(profile);
  await chrome.storage.local.set({ profiles, selectedProfileId: profile.id });
  return { ok: true, profile, created: true };
}

function matchingProfiles(profiles, chatTitle, contactName = '') {
  const list = migrateProfiles(profiles || []);
  const title = String(chatTitle || '').toLowerCase();
  const contact = String(contactName || '').toLowerCase();
  const specific = list
    .map((p, index) => ({ p, index, score: matchScore(p, title, contact) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ p }) => p);
  const generic = list.filter(p => p.isGeneric);
  const matches = [...specific, ...generic.filter(g => !specific.some(s => s.id === g.id))];
  return matches.length ? matches : list.slice(0, 1);
}

function matchScore(profile, title, contact) {
  const titleScore = Math.max(0, ...(profile.matchTexts || [])
    .map(match => String(match || '').toLowerCase())
    .filter(match => match && title.includes(match))
    .map(match => match.length));
  const contactScore = Math.max(0, ...(profile.matchContacts || [])
    .map(match => String(match || '').toLowerCase())
    .filter(match => match && (contact.includes(match) || title.includes(match)))
    .map(match => 1000 + match.length));
  return Math.max(titleScore, contactScore);
}

function pickProfile(profiles, chatTitle, contactName = '') {
  return matchingProfiles(profiles, chatTitle, contactName)[0] || null;
}

function migrateProfiles(list) {
  return list.map(p => {
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
  });
}

async function callAIProvider(payload) {
  const { apiKey, apiKeys = {}, provider, model } = await chrome.storage.local.get(['apiKey', 'apiKeys', 'provider', 'model']);
  const selectedProvider = payload.provider || provider || DEFAULT_PROVIDER;
  const selectedModel = payload.model || model || DEFAULT_MODELS[selectedProvider] || DEFAULT_MODELS.groq;
  const selectedKey = apiKeys[selectedProvider] || (selectedProvider === 'groq' ? apiKey : '');

  const common = {
    apiKey: selectedKey,
    model: selectedModel,
    temperature: payload.temperature ?? 0.3,
    system: payload.system,
    user: payload.user
  };

  if (selectedProvider === 'groq') return callOpenAICompatibleChat({ ...common, baseUrl: 'https://api.groq.com/openai/v1', providerName: 'Groq' });
  if (selectedProvider === 'openai') return callOpenAICompatibleChat({ ...common, baseUrl: 'https://api.openai.com/v1', providerName: 'OpenAI' });
  if (selectedProvider === 'claude') return callClaudeMessages(common);

  throw new Error(`Provider "${selectedProvider}" is not implemented.`);
}

async function callOpenAICompatibleChat({ apiKey, model, temperature, system, user, baseUrl, providerName }) {
  if (!apiKey) throw new Error(`Missing ${providerName} API key. Add it in Options.`);

  const body = {
    model,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!response.ok) {
    const detail = json?.error?.message || json?.message || text || response.statusText;
    throw new Error(`${providerName} request failed (${response.status}): ${detail}`);
  }

  const draft = json?.choices?.[0]?.message?.content?.trim();
  if (!draft) throw new Error(`No draft returned by ${providerName}.`);
  return { ok: true, draft };
}

async function callClaudeMessages({ apiKey, model, temperature, system, user }) {
  if (!apiKey) throw new Error('Missing Claude API key. Add it in Options.');

  const body = {
    model,
    max_tokens: 1000,
    temperature,
    system,
    messages: [{ role: 'user', content: user }]
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!response.ok) {
    const detail = json?.error?.message || json?.message || text || response.statusText;
    throw new Error(`Claude request failed (${response.status}): ${detail}`);
  }

  const draft = (json?.content || [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
  if (!draft) throw new Error('No draft returned by Claude.');
  return { ok: true, draft };
}

async function addDebugEntry(entry) {
  const { debugEnabled = true, debugHistory = [] } = await chrome.storage.local.get(['debugEnabled', 'debugHistory']);
  if (!debugEnabled) return;
  const compact = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...entry
  };
  const next = [compact, ...(Array.isArray(debugHistory) ? debugHistory : [])].slice(0, MAX_DEBUG_HISTORY);
  await chrome.storage.local.set({ debugHistory: next });
}
