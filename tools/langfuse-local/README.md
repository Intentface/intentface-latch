# Local Langfuse for Edge Eval v0 review queues

Self-hosted Langfuse (**v3 images** — v4's default mode removes the legacy trace/score reads and
batch ingestion that `packages/langfuse` still uses; see plan finding 13) on this machine, used for the human-review step of the Edge
evaluation: three reviewers (Ville, Joni, Valtteri), one queue each, blinded D-vs-A pairs.

```
cp .env.example .env          # dev-only values; edit if you like
docker compose up -d          # web UI → http://localhost:3100
docker compose down           # stop (data kept in named volumes)
docker compose down -v        # wipe everything
```

First boot creates, headlessly: an admin user (LANGFUSE_INIT_USER_*), the org + project, and
fixed API keys (LANGFUSE_INIT_PROJECT_*_KEY). Reviewer accounts (Ville, Joni, Valtteri — `<name>@intentface.local`, password
`edge-review-<name>-2026`) and their org memberships are created by `./setup-reviewers.sh`
(run after first boot; idempotent). It also writes `EDGE_REVIEWER_IDS` for the queue assignment.

The eval scripts point at this instance through `apps/latch-platform/.env.langfuse-local`
(passed as a second `--env-file`), so the latch dev server keeps its own Langfuse settings.
