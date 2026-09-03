#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Uso: %s <checkout-p40> <python-3.12+>\n' "$0" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
p40_root="$(realpath "$1")"
python_bin="$2"
[ -x "$python_bin" ] || {
  printf 'O Python informado não é executável: %s\n' "$python_bin" >&2
  exit 1
}
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
launcher="$repo_root/research/phase-0.5/launchers/start-wsl.sh"

if ss -ltn 'sport = :11434' | tail -n +2 | grep -q .; then
  printf 'A prova controlada exige a porta 11434 livre.\n' >&2
  exit 1
fi

fixture="$(mktemp -d -t dz23-phase05-local-ai-XXXXXX)"
server_pid=""
sensitive_fixture="$p40_root/.env.phase05-negative-proof"
[ ! -e "$sensitive_fixture" ] || {
  printf 'A fixture negativa já existe: %s\n' "$sensitive_fixture" >&2
  exit 1
}
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  case "$fixture" in
    /tmp/dz23-phase05-local-ai-*) rm -rf -- "$fixture" ;;
    *) printf 'Fixture não removida por segurança: %s\n' "$fixture" >&2 ;;
  esac
  rm -f -- "$sensitive_fixture"
}
trap cleanup EXIT

mkdir -p "$fixture/api"
printf '%s' '{"models":[{"name":"dz23-local-proof"}]}' > "$fixture/api/tags"
python3 -m http.server 11434 --bind 127.0.0.1 --directory "$fixture" \
  >"$fixture/http.log" 2>&1 &
server_pid=$!

ready=false
for _ in 1 2 3 4 5; do
  if curl --noproxy '*' --fail --silent http://127.0.0.1:11434/api/tags >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || {
  printf 'A IA local simulada não iniciou.\n' >&2
  exit 1
}

output="$(
  ANTHROPIC_API_KEY=host-secret-should-not-pass \
  OPENAI_BASE_URL=http://203.0.113.1 \
  bash "$launcher" "$p40_root" P05-R9 18080 preflight "$python_bin"
)"
printf '%s\n' "$output"
grep -F 'ROUTING_ISOLATION_PROOF=PASS' <<< "$output" >/dev/null
grep -F '"status":"PASS"' <<< "$output" >/dev/null
grep -F '"local_ai":"Ollama"' <<< "$output" >/dev/null

printf 'ANTHROPIC_API_KEY=fake\n' > "$sensitive_fixture"
if sensitive_output="$(
  bash "$launcher" "$p40_root" P05-R9 18080 preflight "$python_bin" 2>&1
)"; then
  printf 'O lançador aceitou uma credencial ignorada pelo Git.\n' >&2
  exit 1
fi
grep -F 'arquivos sensíveis ignorados pelo Git' <<< "$sensitive_output" >/dev/null
rm -f -- "$sensitive_fixture"
printf 'IGNORED_SECRET_PROOF=PASS\n'

printf 'PHASE05_LAUNCHER_PROOF=PASS\n'
