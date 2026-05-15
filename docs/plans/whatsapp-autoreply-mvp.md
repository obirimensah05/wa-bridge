# WhatsApp Autoreply MVP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a local WhatsApp draft/autoreply system on top of `wa-bridge` with default draft mode, time-window/contact/group toggles, style-training corpus generation from outbound WhatsApp history plus Obiri's second brain, and auditable logging.

**Architecture:** Keep `wa-bridge` as the transport/event source. Add a separate local autoreply service inside the repo that receives immediate inbound webhooks from `wa-bridge`, enriches events from the SQLite/API layer, generates replies in Obiri's style, sends drafts to a notification webhook, optionally auto-sends through `wa-bridge`, and writes logs/state locally. Voice notes should be transcribed before reply generation when possible.

**Tech Stack:** TypeScript, Fastify, existing `wa-bridge` SQLite + REST surfaces, local JSON/SQLite-backed state, Claude Code CLI for implementation help.

---

## MVP slices

1. **Service scaffold**
   - Add a new local autoreply HTTP service entrypoint.
   - Add env/config loading for service port, inbound auth token, notification webhook target, wa-bridge API base/token, and generation controls.

2. **Policy + toggle state**
   - Support modes/scopes:
     - draft-only default
     - auto off
     - auto for all
     - auto for contacts
     - auto for groups
     - auto for limited hours / until timestamp
   - Persist state locally.

3. **Training corpus builder**
   - Export/select outbound WhatsApp messages from `wa.db`.
   - Pull relevant writing samples from Obiri's second brain via local Supabase-backed project files.
   - Build a reusable style corpus artifact for prompt context.

4. **Inbound event handling**
   - Accept webhook payloads from `wa-bridge`.
   - Enrich with latest conversation/message context.
   - For audio/voice notes, wait/retry for transcript if needed.

5. **Reply generation**
   - Generate structured output containing:
     - recommended action (`draft`, `auto_send`, `skip`, `escalate`)
     - reply text
     - rationale / safety notes
     - confidence/risk fields
   - Apply safety logic before auto-send.

6. **Delivery + notifications**
   - Draft mode: send formatted draft notification through a configurable webhook target.
   - Auto mode: send through `wa-bridge` send surface.
   - Log every decision/action.

7. **Verification**
   - Add at least smoke-level validation for config loading, policy decisions, and structured generation parsing.
   - Run typecheck / test command(s).
