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

sensitive_ignored="$(
  "${git_command[@]}" ls-files --others --ignored --exclude-standard |
    grep -Ei '(^|/)\.env($|\.)|\.(key|pem|p12|pfx|crt)$' |
    grep -Eiv '(^|/)\.env\.(example|sample|template)$' || true
)"
[ -z "$sensitive_ignored" ] || {
  printf 'O checkout contém arquivos sensíveis ignorados pelo Git:\n%s\n' "$sensitive_ignored" >&2
  printf 'Use uma cópia de pesquisa sem credenciais, chaves ou certificados.\n' >&2
  exit 1
}

python_bin=""
if [ -n "$requested_python" ]; then
  [ -x "$requested_python" ] || {
    printf 'O Python informado não é executável: %s\n' "$requested_python" >&2
    exit 1
  }
  if "$requested_python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null; then
    python_bin="$(cd "$(dirname "$requested_python")" && pwd -P)/$(basename "$requested_python")"
  fi
else
  for candidate in python3.13 python3.12 python3; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null; then
      python_bin="$(command -v "$candidate")"
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
local_ai_env=""
local_ai_base=""
for probe in \
  "Ollama|OLLAMA_HOST|http://127.0.0.1:11434|http://127.0.0.1:11434/api/tags" \
  "LM Studio|LMSTUDIO_HOST|http://127.0.0.1:1234|http://127.0.0.1:1234/v1/models" \
  "vLLM|VLLM_BASE_URL|http://127.0.0.1:8000|http://127.0.0.1:8000/v1/models"; do
  IFS='|' read -r label candidate_env candidate_base url <<< "$probe"
  if curl --noproxy '*' --fail --silent --max-time 2 "$url" 2>/dev/null |
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
    local_ai_env="$candidate_env"
    local_ai_base="$candidate_base"
    break
  fi
done
[ -n "$local_ai" ] || {
  printf 'Nenhuma IA local respondeu em localhost. Inicie Ollama, LM Studio ou vLLM.\n' >&2
  exit 1
}

python_dir="$(dirname "$python_bin")"
clean_path="$python_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
clean_env=(
  env -i
  "PATH=$clean_path"
  "HOME=$HOME"
  "LANG=${LANG:-C.UTF-8}"
  "PYTHONDONTWRITEBYTECODE=1"
  "PYTHONPATH=$source_root"
  "OMNISEEK_RESEARCH_MODE=on"
  "OMNISEEK_PREFER=api"
  "OMNISEEK_DELEGATED=off"
  "OMNISEEK_OUTPUT_COMPRESSION=off"
  "OMNISEEK_COMPRESSION=off"
  "OMNISEEK_SKILL_LEARNING=false"
  "OMNISEEK_PERMISSION_MODE=ask"
  "OMNISEEK_MCP_SERVERS="
  "$local_ai_env=$local_ai_base"
)

cd "$source_root"
"${clean_env[@]}" "$python_bin" -c 'import fastapi, uvicorn, omniseek' >/dev/null
"${clean_env[@]}" "$python_bin" -m pytest "$source_root/tests/test_research_mode.py" -q

"${clean_env[@]}" \
  ANTHROPIC_API_KEY=fake \
  OPENAI_BASE_URL=http://203.0.113.1 \
  "$python_bin" - <<'PY'
import os
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory(prefix="dz23-fake-cli-") as raw:
    fake = Path(raw) / "claude"
    fake.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    fake.chmod(0o700)
    os.environ["PATH"] = raw + os.pathsep + os.environ["PATH"]

    from omniseek import local_ai, routing
    from omniseek.delegated import is_installed

    assert is_installed("claude") is True
    assert routing.cli_routes() == {}
    assert routing._api_entries() == []
    for candidate in local_ai.CANDIDATOS:
        os.environ[candidate.variavel] = "http://203.0.113.1"
        assert local_ai._endereco(candidate) in {
            f"http://127.0.0.1:{candidate.porta}",
            f"http://localhost:{candidate.porta}",
        }

print("ROUTING_ISOLATION_PROOF=PASS")
PY

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

printf '\nPreflight: PASS\n'
printf 'Participante: %s\n' "$participant_id"
printf 'IA local: %s\n' "$local_ai"
printf 'Abra no navegador: http://127.0.0.1:%s/studio\n' "$port"
printf 'Encerre com Ctrl+C.\n\n'

cd "$data_root"
exec "${clean_env[@]}" \
  "OMNISEEK_DATA_DIR=$data_root" \
  "$python_bin" -m omniseek.cli research --host 127.0.0.1 --port "$port" --no-open
