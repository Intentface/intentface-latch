#!/usr/bin/env bash
# Edge Eval v0 — create the three reviewer accounts in the LOCAL Langfuse and give them
# project access. Idempotent: re-running updates nothing that already exists.
#   ./setup-reviewers.sh            (from tools/langfuse-local, stack must be up)
# Writes EDGE_REVIEWER_IDS into apps/latch-platform/.env.langfuse-local for the queue assignment.
set -euo pipefail
cd "$(dirname "$0")"
BASE=${LANGFUSE_LOCAL_URL:-http://localhost:3100}
ORG=${LANGFUSE_INIT_ORG_ID:-org-intentface-local}
ENV_OUT="../../apps/latch-platform/.env.langfuse-local"
REVIEWERS=("ville:Ville:ville@intentface.local" "joni:Joni:joni@intentface.local" "valtteri:Valtteri:valtteri@intentface.local")
PASSWORD_PREFIX=${REVIEWER_PASSWORD_PREFIX:-edge-review}

ids=()
for r in "${REVIEWERS[@]}"; do
  IFS=: read -r key name email <<<"$r"
  pw="${PASSWORD_PREFIX}-${key}-2026"
  code=$(curl -s -o /tmp/lf-signup.json -w '%{http_code}' --max-time 20 -X POST "$BASE/api/auth/signup" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$pw\",\"name\":\"$name\"}")
  case "$code" in
    200) echo "created  $name <$email> (password: $pw)";;
    422|409) echo "exists   $name <$email>";;
    *) echo "signup $email → HTTP $code: $(cat /tmp/lf-signup.json)"; exit 1;;
  esac
  uid=$(docker compose exec -T postgres psql -U postgres -d postgres -tA -c "select id from users where email='$email'")
  [ -n "$uid" ] || { echo "no user row for $email"; exit 1; }
  docker compose exec -T postgres psql -U postgres -d postgres -q -c \
    "insert into organization_memberships (id, org_id, user_id, role) values (gen_random_uuid()::text, '$ORG', '$uid', 'MEMBER') on conflict (org_id, user_id) do nothing;"
  ids+=("$key:$uid")
done

# Record the ids for createQueueAssignment (replace any previous line).
joined=$(IFS=,; echo "${ids[*]}")
if [ -f "$ENV_OUT" ]; then grep -v '^EDGE_REVIEWER_IDS=' "$ENV_OUT" > "$ENV_OUT.tmp" || true; mv "$ENV_OUT.tmp" "$ENV_OUT"; fi
echo "EDGE_REVIEWER_IDS=$joined" >> "$ENV_OUT"
echo
echo "memberships:"; docker compose exec -T postgres psql -U postgres -d postgres -c "select u.email, u.name, m.role from organization_memberships m join users u on u.id=m.user_id where m.org_id='$ORG' order by m.role, u.email"
echo "wrote EDGE_REVIEWER_IDS to $ENV_OUT"
