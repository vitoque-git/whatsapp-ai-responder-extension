# WhatsApp AI Responder

A Chrome Manifest V3 extension that adds AI-assisted reply drafting to WhatsApp Web message menus.

It is designed as a drafting assistant, not an auto-sender: generated replies are inserted into the WhatsApp composer for human review before sending.

## Features

- Adds `Draft using <profile>` items to WhatsApp Web message menus
- Supports multiple matching profiles for the same chat
- Generic profiles can match all chats, while specific profiles can match one or more chat-title substrings
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


## Debugging

Options includes a local debug history. Each entry shows the profile used and has **Copy JSON** so you can copy the exact selected message, recent messages, prompts, provider/model, response, and errors when reporting an issue.

## Notes on WhatsApp menus

WhatsApp Web changes its menu HTML frequently. This extension inserts WhatsApp-like menu rows and resolves the target message by comparing the open menu position with visible messages, then falls back to the last clicked message.


## 0.6.5

Fixes a content-script syntax error that prevented WhatsApp Web from being read, restores menu injection, adds contact matching, user identity names, and popup debug logging.


## 0.6.5

- Improves direct-chat support by detecting smaller WhatsApp message menus and activating WhatsApp's native Reply immediately before generating the draft.
- Relaxes message-menu detection so direct chats and media/text menus without group-only rows can still show AI profile actions.
