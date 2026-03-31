# PicnicHealth Cascade Engine

Node.js server replacing n8n date cascade workflows for PicnicHealth's Notion-based clinical study management.

## Quick Start

1. Copy `.env.example` to `.env` and fill in your Notion token(s) + DB IDs
2. `npm install`
3. `npm run dev` — starts server on port 3000
4. `npm test` — runs all tests

## Manual Dry-Run Before Webhook Swap

Use this to validate behavior before changing production Notion automation URLs.

1. Patch a task date directly in Notion:
   - `npm run patch:task-date -- --task <taskPageId> --start 2026-04-10 --end 2026-04-11`
2. Fire local date-cascade webhook for the same task:
   - `npm run fire:date-webhook -- --task <taskPageId>`

Optional:
- Override local endpoint URL:
  - `npm run fire:date-webhook -- --task <taskPageId> --url http://localhost:3000/webhook/date-cascade`
- Override token:
  - add `--token <notion_token>`

## Architecture

- **src/engine/** — Pure function modules (cascade, parent-subtask, classify). No Notion calls. Fully testable.
- **src/notion/** — Notion API client with retry, rate limiting, token rotation.
- **src/routes/** — Express webhook handlers that orchestrate engine + Notion calls.
- **src/gates/** — Anti-loop gate checks (LMBS, Import Mode, Complete Freeze).
- **test/** — Vitest. Engine tests use fixture data, no mocking needed.

## Webhook Endpoints

| Endpoint | Trigger | Purpose |
|---|---|---|
| `POST /webhook/date-cascade` | Notion "When Dates changes" automation | Cascade date changes through dependency chains |
| `POST /webhook/status-rollup` | Notion "When Status changes" automation | Roll up subtask status to parent |
| `GET /health` | Manual | Health check |

## Status

Phase 1 scaffold complete. Algorithm code pending Phase 0 source verification (need to pull fresh code from live n8n).
