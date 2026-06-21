let lastFocusedEditable = null;
let lastMessageNode = null;
let lastMenuContainer = null;
let lastMenuMessageNode = null;
let lastPointerEvent = null;
let draftClickInFlight = false;
let menuObserverStarted = false;
let cachedMenuProfiles = [];
let cachedMenuProfilesChatTitle = null;
let profileLoadInFlight = false;

const WGD_MENU_ID = 'wai-reply-menu-item';
const WGD_MENU_SELECTOR = `#${WGD_MENU_ID}, [data-wai-menu-item="true"]`;
const WGD_TOAST_ID = 'wgd-toast';

startWhatsAppMenuIntegration();

document.addEventListener('focusin', (event) => {
  if (isEditable(event.target)) lastFocusedEditable = event.target;
}, true);

document.addEventListener('mousedown', rememberMessageFromEvent, true);
document.addEventListener('click', rememberMessageFromEvent, true);
document.addEventListener('contextmenu', rememberMessageFromEvent, true);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'READ_CONTEXT') {
    sendResponse({ ok: true, context: readWhatsAppContext() });
    return;
  }
  if (message?.type === 'INSERT_DRAFT') {
    const ok = insertDraftIntoWhatsApp(message.draft || '');
    sendResponse({ ok });
  }
});

function startWhatsAppMenuIntegration() {
  if (menuObserverStarted) return;
  menuObserverStarted = true;

  const observer = new MutationObserver(() => addAIOptionToOpenMenus());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(addAIOptionToOpenMenus, 1200);
}

function addAIOptionToOpenMenus() {
  const menu = findOpenWhatsAppMenu();
  if (!menu) return;

  const chatTitle = getChatTitle();
  if (cachedMenuProfilesChatTitle !== chatTitle) {
    cachedMenuProfilesChatTitle = chatTitle;
    cachedMenuProfiles = [];
    loadMatchingProfiles(chatTitle);
  }

  removeStaleAIMenuItems(menu);
  if (menu.querySelector(WGD_MENU_SELECTOR)) return;

  lastMenuContainer = menu;
  lastMenuMessageNode = findMessageNearestMenu(menu) || lastMessageNode;

  const firstItem = findNativeMenuItemByLabel(menu, 'Reply') || findMenuItemByText(menu, 'Reply');
  if (!firstItem) return;

  const profiles = cachedMenuProfiles.length
    ? cachedMenuProfiles
    : [{ id: '', name: 'AI' }];
  const items = profiles.map(profile => buildAIMenuItem(firstItem, profile));

  const insertionParent = firstItem.parentElement;
  if (insertionParent && menu.contains(insertionParent)) {
    // Insert all items before WhatsApp's native Reply menu item, preserving order.
    // The items are cloned from the native row, so they inherit WhatsApp's own
    // spacing, typography, hover state, and icon container classes.
    for (const item of items) insertionParent.insertBefore(item, firstItem);
  }
}

async function loadMatchingProfiles(chatTitle) {
  if (profileLoadInFlight) return;
  profileLoadInFlight = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_MATCHING_PROFILES',
      payload: { chatTitle, contactName: getContactName() }
    });
    if (response?.ok && cachedMenuProfilesChatTitle === chatTitle) {
      cachedMenuProfiles = response.profiles || [];
      const menu = findOpenWhatsAppMenu();
      if (menu) {
        menu.querySelectorAll(WGD_MENU_SELECTOR).forEach(el => el.remove());
        addAIOptionToOpenMenus();
      }
    }
  } catch (_) {
    // Keep fallback item; generation will show the actual error if one remains.
  } finally {
    profileLoadInFlight = false;
  }
}

function removeStaleAIMenuItems(currentMenu) {
  document.querySelectorAll(WGD_MENU_SELECTOR).forEach(el => {
    if (!currentMenu.contains(el)) el.remove();
  });
}

function findOpenWhatsAppMenu() {
  const candidates = Array.from(document.querySelectorAll('[role="application"], [role="menu"], [aria-label*="menu" i], div'));
  return candidates
    .filter(isVisible)
    .filter(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 150 || rect.width > 560 || rect.height < 80 || rect.height > 820) return false;

      const text = cleanText(el.innerText || el.textContent || '');
      const hasReply = !!findNativeMenuItemByLabel(el, 'Reply') || /(^|\n)Reply(\n|$)/i.test(text);
      if (!hasReply) return false;

      // Direct chats have a smaller menu than group chats, and media messages
      // may not show Copy. Do not require group-only rows such as Reply
      // privately / Message <number>. We only need enough evidence that this is
      // WhatsApp's message context menu rather than the page itself.
      const knownRows = ['Copy', 'Forward', 'Star', 'React', 'Delete', 'Report', 'Message ', 'Reply privately', 'Ask Meta AI'];
      const rowHits = knownRows.filter(row => text.includes(row)).length;
      const menuItemHits = el.querySelectorAll('[role="menuitem"], button[aria-label]').length;
      return rowHits >= 1 || menuItemHits >= 2;
    })
    .sort((a, b) => area(a) - area(b))[0] || null;
}

function buildAIMenuItem(templateItem, profile) {
  const profileName = profile?.name || 'AI';
  const label = `Draft using ${profileName}`;

  const item = templateItem.cloneNode(true);
  item.removeAttribute('id');
  item.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  item.setAttribute('role', item.getAttribute('role') || 'menuitem');
  item.setAttribute('tabindex', '0');
  replaceMenuItemLabel(item, label);
  replaceMenuItemIconWithSparkle(item);

  item.id = profile?.id ? `${WGD_MENU_ID}-${cssSafe(profile.id)}` : WGD_MENU_ID;
  item.dataset.waiMenuItem = 'true';
  item.dataset.waiProfileId = profile?.id || '';
  item.title = `Draft a reply using the ${profileName} profile`;
  item.setAttribute('aria-label', label);

  item.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (draftClickInFlight) return;
    draftClickInFlight = true;
    try {
      await draftReplyFromMenu(profile?.id || '');
    } finally {
      setTimeout(() => { draftClickInFlight = false; }, 600);
    }
  }, true);
  item.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (draftClickInFlight) return;
      draftClickInFlight = true;
      try {
        await draftReplyFromMenu(profile?.id || '');
      } finally {
        setTimeout(() => { draftClickInFlight = false; }, 600);
      }
    }
  }, true);

  return item;
}

function findNativeMenuItemByLabel(root, label) {
  if (!root) return null;
  const wanted = String(label || '').trim().toLowerCase();
  const selectors = [
    `[aria-label="${cssEscapeForSelector(label)}"][role="menuitem"]`,
    `[aria-label="${cssEscapeForSelector(label)}"]`,
    `button[role="menuitem"]`
  ];

  for (const selector of selectors) {
    const candidates = Array.from(root.querySelectorAll(selector));
    const match = candidates.find(el => {
      if (!isVisible(el) || el.matches?.(WGD_MENU_SELECTOR)) return false;
      const aria = cleanText(el.getAttribute('aria-label') || '').toLowerCase();
      const text = cleanText(el.innerText || el.textContent || '').toLowerCase();
      return aria === wanted || text === wanted;
    });
    if (match) return match;
  }

  return null;
}

function cssEscapeForSelector(value) {
  if (window.CSS?.escape) return CSS.escape(String(value || ''));
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\"');
}

function replaceMenuItemLabel(item, label) {
  const candidates = Array.from(item.querySelectorAll('span, div'))
    .filter(el => isVisible(el))
    .filter(el => {
      const text = cleanText(el.innerText || el.textContent || '');
      return text.toLowerCase() === 'reply' || text.length <= 80;
    })
    .sort((a, b) => {
      const at = cleanText(a.innerText || a.textContent || '').toLowerCase();
      const bt = cleanText(b.innerText || b.textContent || '').toLowerCase();
      return (bt === 'reply') - (at === 'reply') || area(a) - area(b);
    });
  const exact = candidates.find(el => cleanText(el.innerText || el.textContent || '').toLowerCase() === 'reply');
  const target = exact || candidates[candidates.length - 1] || item;
  target.textContent = label;
}

function replaceMenuItemIconWithSparkle(item) {
  // Re-use the native icon container from WhatsApp's row; only replace the
  // SVG itself. This avoids custom padding/gap/line-height that makes the row
  // visually drift from the native menu.
  const svg = item.querySelector('svg');
  if (!svg) return;
  const replacement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  replacement.setAttribute('viewBox', '0 0 24 24');
  replacement.setAttribute('height', svg.getAttribute('height') || '18');
  replacement.setAttribute('width', svg.getAttribute('width') || '18');
  replacement.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  replacement.setAttribute('fill', 'currentColor');
  replacement.innerHTML = '<title>WhatsApp AI Responder</title><path fill="currentColor" d="M12 2.75c.23 0 .43.16.49.38l.93 3.44a4.6 4.6 0 0 0 3.25 3.25l3.44.93a.5.5 0 0 1 0 .97l-3.44.93a4.6 4.6 0 0 0-3.25 3.25l-.93 3.44a.5.5 0 0 1-.97 0l-.93-3.44a4.6 4.6 0 0 0-3.25-3.25l-3.44-.93a.5.5 0 0 1 0-.97l3.44-.93a4.6 4.6 0 0 0 3.25-3.25l.93-3.44A.5.5 0 0 1 12 2.75Zm6.5 13.25c.2 0 .37.13.43.32l.32 1.08c.2.68.73 1.21 1.41 1.41l1.08.32a.45.45 0 0 1 0 .86l-1.08.32c-.68.2-1.21.73-1.41 1.41l-.32 1.08a.45.45 0 0 1-.86 0l-.32-1.08a2.06 2.06 0 0 0-1.41-1.41l-1.08-.32a.45.45 0 0 1 0-.86l1.08-.32c.68-.2 1.21-.73 1.41-1.41l.32-1.08c.06-.19.23-.32.43-.32Z"></path>';
  svg.replaceWith(replacement);
}

function cssSafe(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function draftReplyFromMenu(profileId = '') {
  const menu = lastMenuContainer || findOpenWhatsAppMenu();
  const isGroupMenu = menuLooksLikeGroupMenu(menu);
  const menuMessage = menu ? findMessageNearestMenu(menu) : null;
  let targetMessage = extractSingleMessage(menuMessage) || extractSingleMessage(lastMenuMessageNode) || extractSingleMessage(lastMessageNode) || getFocusedMenuMessageText() || '';

  // Direct chats are harder than groups because the menu can be rendered far
  // from the clicked bubble and WhatsApp does not include group-only rows such
  // as "Reply privately". In that case, if our geometric match points to an
  // older incoming bubble, prefer the latest visible incoming message. This
  // matches the common direct-chat flow and avoids replying to stale messages.
  if (!isGroupMenu) {
    const latestIncoming = getLatestVisibleIncomingMessage();
    if (latestIncoming && shouldPreferLatestDirectMessage(targetMessage, latestIncoming)) {
      targetMessage = latestIncoming;
    }
  }

  const context = readWhatsAppContext();
  const messageText = targetMessage || context.selectedText || context.recentMessages || context.pageText || '';

  if (!messageText.trim()) {
    showToast('No message detected. Click the message menu again.', true);
    return;
  }

  // Click WhatsApp's native Reply immediately, while the original menu is still
  // open. This is more reliable in direct chats, where the menu may close or
  // re-render during the AI request. It also lets WhatsApp itself bind the
  // reply preview to the exact message selected by the user.
  const replyActivated = activateNativeReplyIfPossible(menu);
  showToast(replyActivated ? 'Generating AI draft…' : 'Generating AI draft. Could not activate WhatsApp Reply yet…');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'AI_DRAFT_REPLY',
      payload: {
        chatTitle: context.chatTitle || '',
        contactName: context.contactName || '',
        profileId,
        selectedMessage: messageText,
        recentMessages: context.recentMessages || ''
      }
    });

    if (!response?.ok) throw new Error(response?.error || 'Unknown AI provider error');

    await wait(replyActivated ? 150 : 250);
    if (!replyActivated) activateNativeReplyIfPossible(findOpenWhatsAppMenu() || menu);
    const ok = insertDraftIntoWhatsApp(response.draft || '');
    showToast(ok ? 'Draft inserted. Review before sending.' : 'Draft ready, but I could not find the WhatsApp input.', !ok);
  } catch (e) {
    showToast(e.message || String(e), true);
  }
}

function pickProfile(profiles, chatTitle) {
  const list = migrateProfiles(profiles || []);
  const title = String(chatTitle || '').toLowerCase();
  return list.find(p => p.matchText && title.includes(String(p.matchText).toLowerCase())) ||
    list.find(p => !p.matchText) ||
    list[0] || null;
}

function migrateProfiles(list) {
  return list.map(p => ({ ...p, matchText: p.matchText ?? p.urlMatch ?? '' }));
}

function activateNativeReplyIfPossible(menu) {
  const replyItem = findMenuItemByText(menu || lastMenuContainer || document, 'Reply');
  if (!replyItem) return false;
  try {
    replyItem.click();
    return true;
  } catch (_) {
    return false;
  }
}
function menuLooksLikeGroupMenu(menu) {
  if (!menu) return false;
  const text = cleanText(menu.innerText || menu.textContent || '');
  return /(^|\n)Reply privately(\n|$)/i.test(text) || /(^|\n)Message \+?\d/i.test(text);
}

function shouldPreferLatestDirectMessage(candidate, latestIncoming) {
  const c = cleanText(candidate || '');
  const l = cleanText(latestIncoming || '');
  if (!l) return false;
  if (!c) return true;
  if (c === l || c.includes(l) || l.includes(c)) return false;

  const cTime = extractMessageTimeMs(c);
  const lTime = extractMessageTimeMs(l);
  // If the latest incoming message is newer, prefer it in direct chats.
  if (Number.isFinite(cTime) && Number.isFinite(lTime) && lTime > cTime) return true;

  // If timestamps are unavailable, avoid using a stale geometric candidate
  // when the latest incoming line is present in the recent context.
  return !Number.isFinite(cTime) || !Number.isFinite(lTime);
}

function extractMessageTimeMs(message) {
  const match = String(message || '').match(/^\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\]/);
  if (!match) return NaN;
  const [, hh, mm, dd, mo, yyyy] = match.map(Number);
  return new Date(yyyy, mo - 1, dd, hh, mm).getTime();
}

function getLatestVisibleIncomingMessage() {
  const messages = visibleMessageNodesDetailed();
  const incoming = messages.filter(item => item.incoming && item.text);
  return incoming.length ? incoming[incoming.length - 1].text : '';
}

function visibleMessageNodesDetailed() {
  return visibleMessageNodes().map(node => {
    const wrapper = node.closest?.('.message-in, .message-out') || node;
    return {
      node,
      incoming: wrapper.classList?.contains('message-in') || !wrapper.classList?.contains('message-out'),
      outgoing: wrapper.classList?.contains('message-out'),
      text: extractSingleMessage(node)
    };
  });
}


function findMenuItemByText(root, text) {
  if (!root) return null;
  const wanted = String(text || '').trim().toLowerCase();

  const rows = Array.from(root.querySelectorAll('[role="button"], [role="menuitem"]'));
  const exactRow = rows.find(el => !el.matches?.(WGD_MENU_SELECTOR) && isVisible(el) && cleanText(el.innerText || el.textContent || '').toLowerCase() === wanted);
  if (exactRow) return exactRow;

  const textNodes = Array.from(root.querySelectorAll('span, div'))
    .filter(el => !el.matches?.(WGD_MENU_SELECTOR) && isVisible(el) && cleanText(el.innerText || el.textContent || '').toLowerCase() === wanted);

  for (const node of textNodes) {
    const row = node.closest('[role="button"], [role="menuitem"]');
    if (row && root.contains(row) && !row.matches?.(WGD_MENU_SELECTOR)) return row;

    // WhatsApp sometimes uses plain div rows. Walk up until the row-sized parent.
    let cur = node;
    while (cur && cur !== root) {
      const rect = cur.getBoundingClientRect();
      const parentText = cleanText(cur.innerText || cur.textContent || '');
      if (rect.width > 140 && rect.height >= 32 && rect.height <= 72 && parentText === text) return cur;
      cur = cur.parentElement;
    }
  }

  return null;
}

function findFirstMenuItem(root) {
  if (!root) return null;
  return Array.from(root.querySelectorAll('[role="button"], [role="menuitem"], div')).find(el => {
    if (!isVisible(el)) return false;
    const rect = el.getBoundingClientRect();
    const text = cleanText(el.innerText || el.textContent || '');
    return rect.height >= 28 && text.length > 1 && text.length < 80;
  }) || null;
}

function rememberMessageFromEvent(event) {
  if (event.target?.closest?.(WGD_MENU_SELECTOR)) return;
  if (typeof event.clientX === 'number' && typeof event.clientY === 'number') {
    lastPointerEvent = { x: event.clientX, y: event.clientY, time: Date.now() };
  }
  const message = findClosestMessageFromTarget(event.target);
  if (message) lastMessageNode = normalizeMessageNode(message);
}

function findClosestMessageFromTarget(target) {
  if (!target?.closest) return null;
  return target.closest('[data-pre-plain-text], .message-in, .message-out, div[data-id], div[role="row"]');
}

function normalizeMessageNode(node) {
  return node?.closest?.('[data-pre-plain-text]') || node;
}

function findMessageNearestMenu(menu) {
  if (!menu) return null;
  const menuRect = menu.getBoundingClientRect();
  const pointerFresh = lastPointerEvent && Date.now() - lastPointerEvent.time < 5000;

  // First preference: the message around the click that opened WhatsApp's menu.
  if (pointerFresh) {
    const fromPointer = findMessageNearPoint(lastPointerEvent.x, lastPointerEvent.y);
    if (fromPointer) return fromPointer;
  }

  // Second preference: probe around the menu anchor. WhatsApp opens message
  // menus next to the bubble, so the target bubble is usually immediately to
  // the left/right of the menu top.
  const probePoints = [
    [menuRect.left - 8, menuRect.top + 18],
    [menuRect.left - 28, menuRect.top + 18],
    [menuRect.left - 80, menuRect.top + 18],
    [menuRect.right + 8, menuRect.top + 18],
    [menuRect.left - 8, menuRect.top + 42],
    [menuRect.left - 120, menuRect.top + 42]
  ];
  for (const [x, y] of probePoints) {
    const node = findMessageNearPoint(x, y);
    if (node) return node;
  }

  const nodes = visibleMessageNodes();
  let best = null;
  let bestScore = Infinity;

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

    const vertical = Math.min(Math.abs(rect.top - menuRect.top), Math.abs(rect.bottom - menuRect.top), Math.abs((rect.top + rect.bottom) / 2 - (menuRect.top + 24)));
    const horizontalGap = rect.right < menuRect.left ? menuRect.left - rect.right : rect.left > menuRect.right ? rect.left - menuRect.right : 0;
    const score = vertical * 12 + horizontalGap * 0.25;

    if (score < bestScore) {
      bestScore = score;
      best = node;
    }
  }

  return best;
}

function findMessageNearPoint(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const direct = document.elementFromPoint(Math.max(0, Math.min(window.innerWidth - 1, x)), Math.max(0, Math.min(window.innerHeight - 1, y)));
  const directMessage = findClosestMessageFromTarget(direct);
  if (directMessage) return normalizeMessageNode(directMessage);

  let best = null;
  let bestScore = Infinity;
  for (const node of visibleMessageNodes()) {
    const rect = node.getBoundingClientRect();
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const score = dy * 10 + dx;
    if (score < bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return bestScore < 900 ? best : null;
}

function visibleMessageNodes() {
  return Array.from(document.querySelectorAll('#main [data-pre-plain-text], #main .message-in, #main .message-out, #main div[data-id]'))
    .map(normalizeMessageNode)
    .filter((node, index, arr) => node && arr.indexOf(node) === index)
    .filter(isVisible);
}

function extractSingleMessage(node) {
  if (!node) return '';
  const meta = cleanText(node.getAttribute?.('data-pre-plain-text') || '');
  const text = cleanMessageText(node.innerText || node.textContent || '');
  if (!text) return '';
  return meta ? `${meta} ${text}` : text;
}

function getFocusedMenuMessageText() {
  const nodes = Array.from(document.querySelectorAll('#main [data-pre-plain-text], [data-pre-plain-text]'));
  return extractSingleMessage(nodes[nodes.length - 1]);
}

function readWhatsAppContext() {
  const selectedText = String(window.getSelection?.() || '').trim();
  const chatTitle = getChatTitle();
  const contactName = getContactName();
  const recentMessages = extractWhatsAppMessages();
  return {
    url: location.href,
    pageTitle: document.title || '',
    app: 'whatsapp-web',
    chatTitle,
    contactName,
    selectedText,
    recentMessages,
    pageText: fallbackVisibleText()
  };
}

function getChatTitle() {
  const main = document.querySelector('#main');
  const candidates = [
    '#main header span[dir="auto"][title]',
    '#main header [data-testid="conversation-info-header-chat-title"]',
    '#main header span[dir="auto"]',
    'header span[dir="auto"][title]'
  ];
  for (const selector of candidates) {
    const el = document.querySelector(selector);
    const text = cleanText(el?.getAttribute?.('title') || el?.textContent || '');
    if (text && text.length < 120) return text;
  }
  if (main) {
    const headerText = cleanText(main.querySelector('header')?.innerText || '');
    const firstLine = headerText.split('\n').map(s => s.trim()).find(Boolean);
    if (firstLine && firstLine.length < 120) return firstLine;
  }
  return '';
}


function getContactName() {
  // For direct chats this is normally the same as the chat title. For groups,
  // WhatsApp may show participant info in the header, but keeping the title is
  // still useful for profile matching.
  return getChatTitle();
}

function extractWhatsAppMessages() {
  const nodes = Array.from(document.querySelectorAll('#main [data-pre-plain-text], [data-pre-plain-text]'));
  const items = [];

  for (const node of nodes.slice(-40)) {
    const line = extractSingleMessage(node);
    if (!line || line.length < 2) continue;
    if (!items.includes(line)) items.push(line);
  }

  return items.slice(-25).join('\n---\n');
}

function cleanMessageText(text) {
  return cleanText(text)
    .replace(/\n?(Edited|Forwarded)$/i, '')
    .replace(/\n?\d{1,2}:\d{2}\s?(AM|PM)?$/i, '')
    .trim();
}

function fallbackVisibleText() {
  const mainText = cleanText(document.querySelector('#main')?.innerText || '');
  return mainText.slice(-6000);
}

function cleanText(text) {
  return String(text || '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return tag === 'textarea' || tag === 'input' || el.isContentEditable || el.getAttribute?.('contenteditable') === 'true';
}

function findWhatsAppComposer() {
  const selectors = [
    '#main footer div[contenteditable="true"][role="textbox"]',
    '#main footer div[contenteditable="true"][aria-label]',
    '#main footer div[contenteditable="true"]',
    'footer div[contenteditable="true"][role="textbox"]'
  ];

  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll(selector)).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 80 && rect.height > 15 && rect.bottom > window.innerHeight / 2;
    });
    if (candidates.length) return candidates[candidates.length - 1];
  }

  if (isEditable(document.activeElement)) return document.activeElement;
  if (isEditable(lastFocusedEditable)) return lastFocusedEditable;
  return null;
}

function insertDraftIntoWhatsApp(draft) {
  const el = findWhatsAppComposer();
  if (!el) return false;
  const text = String(draft || '').trim();
  if (!text) return false;

  el.focus();

  try {
    // Select only the composer contents, not the whole page. Using
    // document.execCommand('selectAll') is unreliable in WhatsApp Web and can
    // cause duplicate insertion in some focused/reply states.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false, null);

    const ok = document.execCommand('insertText', false, text);
    if (!ok) throw new Error('execCommand insertText failed');
    return true;
  } catch (e) {
    try {
      el.textContent = '';
      el.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, text);
      return true;
    } catch (_) {
      return false;
    }
  }
}

function showToast(text, isError = false) {
  let toast = document.getElementById(WGD_TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = WGD_TOAST_ID;
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.style.cssText = [
    'position:fixed',
    'right:24px',
    'bottom:24px',
    'z-index:2147483647',
    'max-width:420px',
    'padding:12px 14px',
    'border-radius:10px',
    'box-shadow:0 8px 28px rgba(0,0,0,.28)',
    'font:14px/1.35 system-ui,-apple-system,Segoe UI,sans-serif',
    `background:${isError ? '#8b1e1e' : '#1f6f43'}`,
    'color:white'
  ].join(';');

  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { toast.remove(); }, isError ? 7000 : 3500);
}

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') !== 0;
}

function area(el) {
  const rect = el.getBoundingClientRect();
  return rect.width * rect.height;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
