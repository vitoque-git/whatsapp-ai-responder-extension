# WhatsApp AI Responder

A Chrome Manifest V3 extension that adds AI-assisted reply drafting to WhatsApp Web message menus.

It is designed as a drafting assistant, not an auto-sender: generated replies are inserted into the WhatsApp composer for human review before sending.

## Features

- Adds `Draft using <profile>` items to WhatsApp Web message menus
- Supports multiple matching profiles for the same chat
- Empty chat-title match means a profile matches all chats
- Per-profile prompt and Markdown context
- Per-profile provider/model selection
- Provider support:
  - Groq via OpenAI-compatible chat completions
  - OpenAI via chat completions
  - Claude / Anthropic via Messages API
- Optional local debug history showing the exact prompt, selected message, provider/model, reply, and errors
- Popup action to create a profile for the active WhatsApp group/chat

## Local install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Open **Options** and add provider keys.
6. Create or edit profiles.
7. Refresh WhatsApp Web.

## Security note

For local testing, provider API keys are stored in Chrome local extension storage. For serious/public use, use a backend proxy and do not expose provider keys in the browser.

## Repository description

AI-assisted WhatsApp Web reply drafter with per-chat prompts, Markdown context, multiple providers, and local debug history.
