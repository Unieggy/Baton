# Relay

Relay preserves coding-session intent and operational context when an AI agent
hits a rate limit, crashes, or runs out of context. The engine freezes workspace
evidence, distills a validated handoff packet, and resumes the task on another
provider.

## Terminal Companion

The React prototype in `ui/` keeps the terminal live on the left with a slim
Relay rail on the right. While an agent works the rail stays quiet; the moment it
fails, one click (**Create handoff**) streams the continuation straight into the
same terminal as the next agent resumes from a validated packet — the task is
never re-explained. The rail shows the active agent, current task, the
transferred packet, and verification.

The demo fixtures are runtime-validated with the same `RelayEvent` and
`HandoffPacket` Zod schemas used by the engine.

```bash
npm run ui:dev
```

Open `http://127.0.0.1:4173`.

Create a production build with:

```bash
npm run ui:build
```

## Verification

```bash
npm test
npm run typecheck
npm run ui:build
```
