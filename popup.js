let activeTabId;
let activeTabUrl = '';
let pageContext;
let profiles = [];

const $ = id => document.getElementById(id);

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab.id;
  activeTabUrl = tab.url || '';

  const stored = await chrome.storage.local.get(['profiles']);
  profiles = migrateProfiles(stored.profiles || []);

  if (!activeTabUrl.startsWith('https://web.whatsapp.com/')) {
    renderProfiles('');
    updateCreateProfileButton('');
    disableMainControls(true);
    setStatus('Open WhatsApp Web, select a chat, then reopen this popup.', 'error');
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTabId, { type: 'READ_CONTEXT' });
    pageContext = response.context;
    renderProfiles(pageContext.chatTitle || '');
    updateCreateProfileButton(pageContext.chatTitle || '');

    $('chatTitle').textContent = pageContext.chatTitle ? `Chat: ${pageContext.chatTitle}` : 'Chat: not detected';
    const context = pageContext.selectedText || pageContext.recentMessages || pageContext.pageText || '';
    $('context').value = context.slice(-5000);
    setStatus(context ? 'Loaded WhatsApp context. Review it before generating.' : 'No message text detected. Select a message or scroll the chat, then try again.', context ? 'ok' : 'error');
  } catch (e) {
    disableMainControls(true);
    setStatus('Could not read WhatsApp Web. Refresh WhatsApp Web, select a chat, then reopen the extension.', 'error');
  }
}

function migrateProfiles(list) {
  return list.map(p => {
    const oldMatch = p.matchText ?? p.urlMatch ?? '';
    const matchTexts = Array.isArray(p.matchTexts)
      ? p.matchTexts.map(String).map(v => v.trim()).filter(Boolean)
      : (oldMatch ? [String(oldMatch).trim()] : []);
    const matchContacts = Array.isArray(p.matchContacts) ? p.matchContacts.map(String).map(v => v.trim()).filter(Boolean) : [];
    const isGeneric = typeof p.isGeneric === 'boolean' ? p.isGeneric : (!matchTexts.length && !matchContacts.length);
    return { ...p, matchTexts, matchText: matchTexts[0] || '', matchContacts, isGeneric };
  });
}

function matchingProfilesForTitle(list, chatTitle, contactName = '') {
  const title = String(chatTitle || '').toLowerCase();
  const contact = String(contactName || '').toLowerCase();
  const specific = list
    .map((p, index) => ({ p, index, score: matchScore(p, title, contact) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ p }) => p);
  const generic = list.filter(p => p.isGeneric && !specific.some(s => s.id === p.id));
  return [...specific, ...generic, ...list.filter(p => !p.isGeneric && !specific.some(s => s.id === p.id))];
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

function renderProfiles(chatTitle) {
  const select = $('profile');
  select.innerHTML = '';
  profiles = matchingProfilesForTitle(profiles, chatTitle, pageContext?.contactName || '');
  profiles.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });
}

function updateCreateProfileButton(chatTitle) {
  const button = $('createProfileForChat');
  if (!button) return;
  button.disabled = !chatTitle || !activeTabUrl.startsWith('https://web.whatsapp.com/');
  button.textContent = chatTitle ? 'Create a profile for this group' : 'No WhatsApp group detected';
}

function disableMainControls(disabled) {
  ['profile', 'context', 'instruction', 'generate', 'copy', 'insert'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = disabled;
  });
}

$('generate').addEventListener('click', async () => {
  const profile = profiles.find(p => p.id === $('profile').value) || profiles[0];
  if (!profile) return setStatus('No profile found. Add one in Options.', 'error');

  const selectedMessage = [
    $('instruction').value ? `Instruction: ${$('instruction').value}` : '',
    $('context').value || ''
  ].filter(Boolean).join('\n\n');

  setStatus('Generating draft…');
  $('generate').disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'AI_DRAFT_REPLY',
      payload: {
        chatTitle: pageContext?.chatTitle || '',
        contactName: pageContext?.contactName || '',
        profileId: profile.id,
        selectedMessage,
        recentMessages: pageContext?.recentMessages || ''
      }
    });
    if (!response?.ok) throw new Error(response?.error || 'Unknown error');
    $('draft').value = response.draft;
    setStatus('Draft generated. Review before sending.', 'ok');
  } catch (e) {
    setStatus(e.message || String(e), 'error');
  } finally {
    $('generate').disabled = false;
  }
});

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('draft').value || '');
  setStatus('Copied draft.', 'ok');
});

$('insert').addEventListener('click', async () => {
  const draft = $('draft').value || '';
  if (!draft) return setStatus('Nothing to insert.', 'error');
  const response = await chrome.tabs.sendMessage(activeTabId, { type: 'INSERT_DRAFT', draft });
  setStatus(response?.ok ? 'Inserted draft into WhatsApp. Review before sending.' : 'Could not find the WhatsApp input. Click the message box first, then try again.', response?.ok ? 'ok' : 'error');
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = `status ${cls}`;
}


$('createProfileForChat').addEventListener('click', async () => {
  const chatTitle = pageContext?.chatTitle || '';
  if (!chatTitle) return setStatus('Could not detect the current WhatsApp chat title.', 'error');
  setStatus('Creating profile…');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CREATE_PROFILE_FOR_CHAT',
      payload: { chatTitle }
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not create profile.');
    const stored = await chrome.storage.local.get(['profiles']);
    profiles = migrateProfiles(stored.profiles || []);
    renderProfiles(chatTitle);
    if (response.profile?.id) $('profile').value = response.profile.id;
    setStatus(response.created ? 'Profile created. Open Options to edit its prompt and Markdown context.' : 'A matching profile already exists.', 'ok');
    chrome.runtime.openOptionsPage();
  } catch (e) {
    setStatus(e.message || String(e), 'error');
  }
});
