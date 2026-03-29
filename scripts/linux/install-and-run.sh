#!/usr/bin/env bash
set -euo pipefail

write_step() {
  echo
  echo "==> $1"
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
cd "$repo_root"

env_path="$repo_root/.env"

declare -A existing=()
existing_keys=()
if [[ -f "$env_path" ]]; then
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    line="${raw_line#"${raw_line%%[![:space:]]*}"}"
    [[ -z "$line" ]] && continue
    [[ "${line:0:1}" == "#" ]] && continue
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    if [[ -n "$key" ]]; then
      if [[ -z "${existing[$key]+x}" ]]; then
        existing_keys+=("$key")
      fi
      existing["$key"]="$value"
    fi
  done < "$env_path"
fi

default_or_existing() {
  local key="$1"
  local fallback="$2"
  if [[ -n "${existing[$key]+x}" && -n "${existing[$key]}" ]]; then
    printf '%s' "${existing[$key]}"
  else
    printf '%s' "$fallback"
  fi
}

prompt_default() {
  local label="$1"
  local default="$2"
  local value
  read -r -p "$label [$default]: " value || true
  if [[ -z "${value// }" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "${value#"${value%%[![:space:]]*}"}"
  fi
}

prompt_optional() {
  local label="$1"
  local default="$2"
  local value
  read -r -p "$label [$default] (press Enter to keep, type NONE for blank): " value || true
  if [[ -z "${value// }" ]]; then
    printf '%s' "$default"
    return
  fi

  value="${value#"${value%%[![:space:]]*}"}"
  if [[ "${value^^}" == "NONE" ]]; then
    printf '%s' ""
    return
  fi
  printf '%s' "$value"
}

is_port_available() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn "( sport = :$port )" 2>/dev/null | grep -Eq "[:.]$port[[:space:]]"; then
      return 1
    fi
    return 0
  fi

  if command -v netstat >/dev/null 2>&1; then
    if netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$port$"; then
      return 1
    fi
    return 0
  fi

  return 0
}

prompt_available_port() {
  local label="$1"
  local default="$2"
  local value port
  value="$(prompt_default "$label" "$default")"
  while true; do
    if [[ ! "$value" =~ ^[0-9]+$ ]]; then
      read -r -p "$label must be numeric. Enter a new value: " value || true
      continue
    fi

    port="$value"
    if (( port < 1 || port > 65535 )); then
      read -r -p "$label must be between 1 and 65535. Enter a new value: " value || true
      continue
    fi

    if is_port_available "$port"; then
      printf '%s' "$port"
      return
    fi

    read -r -p "Port $port is already in use. Enter a different $label: " value || true
  done
}

wait_for_http() {
  local url="$1"
  local timeout_seconds="$2"
  local header="${3:-}"
  local elapsed=0
  while (( elapsed < timeout_seconds )); do
    if [[ -n "$header" ]]; then
      if curl -fsS -m 5 -H "$header" "$url" >/dev/null 2>&1; then
        return 0
      fi
    else
      if curl -fsS -m 5 "$url" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

write_step "Checking Docker availability"
command -v docker >/dev/null 2>&1 || { echo "Docker is not available."; exit 1; }
docker version >/dev/null
docker compose version >/dev/null

declare -A defaults=(
  [RXDB_PREMIUM]="$(default_or_existing "RXDB_PREMIUM" "")"
  [BACKEND_GITHUB_SERVER_SCHEMAS_URL]="$(default_or_existing "BACKEND_GITHUB_SERVER_SCHEMAS_URL" "")"
  [BACKEND_TOKEN]="$(default_or_existing "BACKEND_TOKEN" "85533878a62652c01f764ba4d7e154ddaf6e7")"
  [BACKEND_PORT]="$(default_or_existing "BACKEND_PORT" "4000")"
  [BACKEND_DEFAULT_WEBSOCKET_PORT]="$(default_or_existing "BACKEND_DEFAULT_WEBSOCKET_PORT" "4001")"
  [BACKEND_JSON_BODY_LIMIT]="$(default_or_existing "BACKEND_JSON_BODY_LIMIT" "10mb")"
  [FRONTEND_PORT]="$(default_or_existing "FRONTEND_PORT" "8080")"
  [MONGO_PORT]="$(default_or_existing "MONGO_PORT" "27017")"
  [MONGO_INITDB_ROOT_USERNAME]="$(default_or_existing "MONGO_INITDB_ROOT_USERNAME" "rxdbadmin")"
  [MONGO_INITDB_ROOT_PASSWORD]="$(default_or_existing "MONGO_INITDB_ROOT_PASSWORD" "rxdbpass")"
  [MONGO_INITDB_DATABASE]="$(default_or_existing "MONGO_INITDB_DATABASE" "rxdb-workbench")"
  [VITE_INTERNAL_MODE]="$(default_or_existing "VITE_INTERNAL_MODE" "")"
)

if [[ -n "${existing[BACKEND_GITHUB_SERVER_SCHEMAS_URL]+x}" ]]; then
  defaults[BACKEND_GITHUB_SERVER_SCHEMAS_URL]="${existing[BACKEND_GITHUB_SERVER_SCHEMAS_URL]}"
fi

write_step "Configuring environment"
echo "Leave blank to keep defaults."
echo "RXDB premium key is optional. Type NONE if you want no premium key."
defaults[RXDB_PREMIUM]="$(prompt_optional "RXDB_PREMIUM (optional)" "${defaults[RXDB_PREMIUM]}")"
defaults[BACKEND_PORT]="$(prompt_available_port "BACKEND_PORT" "${defaults[BACKEND_PORT]}")"
defaults[BACKEND_DEFAULT_WEBSOCKET_PORT]="$(prompt_available_port "BACKEND_DEFAULT_WEBSOCKET_PORT" "${defaults[BACKEND_DEFAULT_WEBSOCKET_PORT]}")"
defaults[FRONTEND_PORT]="$(prompt_available_port "FRONTEND_PORT" "${defaults[FRONTEND_PORT]}")"
defaults[MONGO_PORT]="$(prompt_available_port "MONGO_PORT" "${defaults[MONGO_PORT]}")"
defaults[MONGO_INITDB_ROOT_USERNAME]="$(prompt_default "MONGO_INITDB_ROOT_USERNAME" "${defaults[MONGO_INITDB_ROOT_USERNAME]}")"
defaults[MONGO_INITDB_ROOT_PASSWORD]="$(prompt_default "MONGO_INITDB_ROOT_PASSWORD" "${defaults[MONGO_INITDB_ROOT_PASSWORD]}")"

while [[ "${defaults[BACKEND_PORT]}" == "${defaults[BACKEND_DEFAULT_WEBSOCKET_PORT]}" ||
         "${defaults[BACKEND_PORT]}" == "${defaults[FRONTEND_PORT]}" ||
         "${defaults[BACKEND_DEFAULT_WEBSOCKET_PORT]}" == "${defaults[FRONTEND_PORT]}" ||
         "${defaults[BACKEND_PORT]}" == "${defaults[MONGO_PORT]}" ||
         "${defaults[BACKEND_DEFAULT_WEBSOCKET_PORT]}" == "${defaults[MONGO_PORT]}" ||
         "${defaults[FRONTEND_PORT]}" == "${defaults[MONGO_PORT]}" ]]; do
  echo "Ports must be unique across backend, websocket, frontend, and mongo."
  defaults[BACKEND_PORT]="$(prompt_available_port "BACKEND_PORT" "${defaults[BACKEND_PORT]}")"
  defaults[BACKEND_DEFAULT_WEBSOCKET_PORT]="$(prompt_available_port "BACKEND_DEFAULT_WEBSOCKET_PORT" "${defaults[BACKEND_DEFAULT_WEBSOCKET_PORT]}")"
  defaults[FRONTEND_PORT]="$(prompt_available_port "FRONTEND_PORT" "${defaults[FRONTEND_PORT]}")"
  defaults[MONGO_PORT]="$(prompt_available_port "MONGO_PORT" "${defaults[MONGO_PORT]}")"
done

defaults[VITE_FRONTEND_TO_USE_FORBACKEND_TOKEN]="${defaults[BACKEND_TOKEN]}"
defaults[VITE_FRONTEND_TO_USE_BACKEND_URL]="http://localhost:${defaults[BACKEND_PORT]}"
defaults[VITE_FRONTEND_TO_USE_BACKEND_WEBSOCKET_PORT]="${defaults[BACKEND_DEFAULT_WEBSOCKET_PORT]}"
defaults[BACKEND_DEFAULT_MONGODB_CONNECTION_STRING]="mongodb://${defaults[MONGO_INITDB_ROOT_USERNAME]}:${defaults[MONGO_INITDB_ROOT_PASSWORD]}@mongodb:27017/${defaults[MONGO_INITDB_DATABASE]}?authSource=admin"
defaults[VITE_FRONTEND_DEFAULT_MONGODB_CONNECTION_STRING]="${defaults[BACKEND_DEFAULT_MONGODB_CONNECTION_STRING]}"

managed_keys=(
  RXDB_PREMIUM
  BACKEND_GITHUB_SERVER_SCHEMAS_URL
  BACKEND_TOKEN
  BACKEND_PORT
  BACKEND_DEFAULT_WEBSOCKET_PORT
  BACKEND_JSON_BODY_LIMIT
  VITE_FRONTEND_TO_USE_FORBACKEND_TOKEN
  VITE_FRONTEND_TO_USE_BACKEND_URL
  VITE_FRONTEND_TO_USE_BACKEND_WEBSOCKET_PORT
  VITE_FRONTEND_DEFAULT_MONGODB_CONNECTION_STRING
  BACKEND_DEFAULT_MONGODB_CONNECTION_STRING
  FRONTEND_PORT
  MONGO_PORT
  MONGO_INITDB_ROOT_USERNAME
  MONGO_INITDB_ROOT_PASSWORD
  MONGO_INITDB_DATABASE
  VITE_INTERNAL_MODE
)

{
  for key in "${managed_keys[@]}"; do
    printf '%s=%s\n' "$key" "${defaults[$key]:-}"
  done

  preserved=()
  for key in "${existing_keys[@]}"; do
    skip=0
    for managed in "${managed_keys[@]}"; do
      if [[ "$key" == "$managed" ]]; then
        skip=1
        break
      fi
    done
    if (( skip == 0 )); then
      printf '%s=%s\n' "$key" "${existing[$key]}"
      preserved+=("$key")
    fi
  done
} > "$env_path"

echo "Wrote $env_path"

write_step "Building and starting containers"
docker compose up -d --build

frontend_url="http://localhost:${defaults[FRONTEND_PORT]}"
backend_health_url="http://localhost:${defaults[BACKEND_PORT]}/api/health"
auth_header="Authorization: Bearer ${defaults[BACKEND_TOKEN]}"

write_step "Waiting for services"
backend_ready=false
frontend_ready=false

if wait_for_http "$backend_health_url" 120 "$auth_header"; then
  backend_ready=true
fi
if wait_for_http "$frontend_url" 120; then
  frontend_ready=true
fi

write_step "Result"
if [[ "$backend_ready" == true && "$frontend_ready" == true ]]; then
  echo "Backend is reachable at $backend_health_url"
  echo "Frontend is reachable at $frontend_url"
  echo "MongoDB is exposed at mongodb://localhost:${defaults[MONGO_PORT]}"
  echo "MongoDB auth user: ${defaults[MONGO_INITDB_ROOT_USERNAME]}"
else
  echo "Services started, but one or more health checks timed out."
  echo "Frontend URL: $frontend_url"
  echo "Backend URL:  $backend_health_url"
fi

if command -v xdg-open >/dev/null 2>&1; then
  echo
  echo "Opening frontend in your default browser..."
  xdg-open "$frontend_url" >/dev/null 2>&1 || true
fi
