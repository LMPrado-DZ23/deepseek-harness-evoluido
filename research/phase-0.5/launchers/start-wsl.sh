#!/usr/bin/env bash
set -euo pipefail

expected_commit="d9a8109528839a9f6c691cab9d71f3fce7e91e02"

usage() {
  printf 'Uso: %s <checkout-p40> <P01..P05[-R1]> [porta] [fresh|resume|preflight] [python]\n' "$0" >&2
  exit 2
}

[ "$#" -ge 2 ] || usage
source_root="$(realpath "$1")"
participant_id="$2"
port="${3:-18080}"
resume="${4:-fresh}"
requested_python="${5:-}"

case "$resume" in
  fresh|resume|preflight) ;;
  *) usage ;;
esac

case "$participant_id" in
  P0[1-5]|P0[1-5]-R[1-9]) ;;
  *) printf 'Identificador inválido. Use P01 a P05 ou P01-R1.\n' >&2; exit 2 ;;
esac

case "$port" in
  ''|*[!0-9]*) printf 'A porta precisa ser numérica.\n' >&2; exit 2 ;;
esac
[ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || {
  printf 'Use uma porta entre 1024 e 65535.\n' >&2
  exit 2
}

[ -f "$source_root/docs/P40_RESEARCH_MODE.md" ] || {
  printf 'O caminho informado não é o checkout P40 esperado.\n' >&2
  exit 1
}

git_command=(git -C "$source_root")
if ! "${git_command[@]}" rev-parse HEAD >/dev/null 2>&1; then
  [ -f "$source_root/.git" ] || {
    printf 'O checkout P40 não possui metadados Git utilizáveis.\n' >&2
    exit 1
  }
  raw_git_dir="$(sed -n 's/^gitdir: //p' "$source_root/.git")"
  case "$raw_git_dir" in
    [A-Za-z]:/*)
      drive="${raw_git_dir:0:1}"
      git_dir="/mnt/${drive,,}${raw_git_dir:2}"
      ;;
    /*) git_dir="$raw_git_dir" ;;
    *) git_dir="$(realpath "$source_root/$raw_git_dir")" ;;
  esac
  [ -d "$git_dir" ] || {
    printf 'O gitdir do worktree P40 não foi encontrado: %s\n' "$git_dir" >&2
    exit 1
  }
  git_command=(git --git-dir="$git_dir" --work-tree="$source_root")
fi

observed_commit="$("${git_command[@]}" rev-parse HEAD)"
[ "$observed_commit" = "$expected_commit" ] || {
  printf 'Commit incorreto: esperado %s, encontrado %s.\n' "$expected_commit" "$observed_commit" >&2
  exit 1
}

[ -z "$("${git_command[@]}" status --porcelain)" ] || {
  printf 'O checkout P40 tem alterações. Use uma cópia limpa.\n' >&2
  exit 1
}

[ ! -f "$source_root/.env" ] || {
  printf 'O checkout contém .env. Remova-o da cópia de pesquisa antes de continuar.\n' >&2
  exit 1
}

python_bin=""
if [ -n "$requested_python" ]; then
  [ -x "$requested_python" ] || {
    printf 'O Python informado não é executável: %s\n' "$requested_python" >&2
    exit 1
  }
  if "$requested_python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null; then
    python_bin="$requested_python"
  fi
else
  for candidate in python3.13 python3.12 python3; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null; then
      python_bin="$candidate"
      break
    fi
  done
fi
[ -n "$python_bin" ] || {
  printf 'Python 3.12 ou superior não foi encontrado no ambiente informado.\n' >&2
  exit 1
}

docker info >/dev/null 2>&1 || {
  printf 'Docker não está disponível dentro do WSL2.\n' >&2
  exit 1
}

if ss -ltn "sport = :$port" | tail -n +2 | grep -q .; then
  printf 'A porta %s já está em uso.\n' "$port" >&2
  exit 1
fi

local_ai=""
for probe in \
  "Ollama|http://127.0.0.1:11434/api/tags" \
  "LM Studio|http://127.0.0.1:1234/v1/models" \
  "vLLM|http://127.0.0.1:8000/v1/models"; do
  label="${probe%%|*}"
  url="${probe#*|}"
  if curl --fail --silent --max-time 2 "$url" 2>/dev/null |
    "$python_bin" -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)
items = payload.get("models") or payload.get("data") if isinstance(payload, dict) else None
valid = isinstance(items, list) and any(
    isinstance(item, dict) and (item.get("name") or item.get("id") or item.get("model"))
    for item in items
)
raise SystemExit(0 if valid else 1)
'; then
    local_ai="$label"
    break
  fi
done
[ -n "$local_ai" ] || {
  printf 'Nenhuma IA local respondeu em localhost. Inicie Ollama, LM Studio ou vLLM.\n' >&2
  exit 1
}

for secret_name in \
  ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY DEEPSEEK_API_KEY \
  GEMINI_API_KEY GROQ_API_KEY FIRECRAWL_API_KEY GITHUB_TOKEN E2B_API_KEY \
  BRAVE_API_KEY EVOLUTION_API_KEY TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN \
  FAL_KEY REPLICATE_API_TOKEN ELEVENLABS_API_KEY HEYGEN_API_KEY \
  ZERNIO_API_KEY IQOPTION_EMAIL IQOPTION_PASSWORD; do
  unset "$secret_name" || true
done

export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$source_root"
cd "$source_root"
"$python_bin" -c 'import fastapi, uvicorn, omniseek' >/dev/null
"$python_bin" -m pytest "$source_root/tests/test_research_mode.py" -q

if [ "$resume" = "preflight" ]; then
  printf '{"status":"PASS","commit":"%s","participant":"%s","local_ai":"%s","port":%s,"python":"%s"}\n' \
    "$observed_commit" "$participant_id" "$local_ai" "$port" "$python_bin"
  exit 0
fi

data_root="$HOME/.local/share/dz23-studio/phase05/$participant_id"
if [ -e "$data_root" ] && [ "$resume" != "resume" ]; then
  printf 'Já existem dados para %s. Use um novo identificador de repetição, como %s-R1.\n' "$participant_id" "$participant_id" >&2
  exit 1
fi
mkdir -p -m 700 "$data_root"

export OMNISEEK_DATA_DIR="$data_root"
export OMNISEEK_RESEARCH_MODE=on
export OMNISEEK_PREFER=api
export OMNISEEK_DELEGATED=off
export OMNISEEK_OUTPUT_COMPRESSION=off
export OMNISEEK_COMPRESSION=off
export OMNISEEK_SKILL_LEARNING=false
export OMNISEEK_PERMISSION_MODE=ask
export OMNISEEK_MCP_SERVERS=""

printf '\nPreflight: PASS\n'
printf 'Participante: %s\n' "$participant_id"
printf 'IA local: %s\n' "$local_ai"
printf 'Abra no navegador: http://127.0.0.1:%s/studio\n' "$port"
printf 'Encerre com Ctrl+C.\n\n'

cd "$data_root"
exec "$python_bin" -m omniseek.cli research --host 127.0.0.1 --port "$port" --no-open
