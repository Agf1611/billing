#!/bin/bash
# ============================================================
#  UPDATE - Portal Pelanggan GenieACS
#  Untuk Ubuntu / Armbian
#  Update source + validasi + restart PM2 instance aktif
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTANCE_NAME="$(basename "$SCRIPT_DIR")"
BACKUP_ROOT="$SCRIPT_DIR/backups/update-$(date +%Y%m%d-%H%M%S)"
PREV_HEAD=""
BRANCH=""
REMOTE_VERSION="-"
LOCAL_VERSION="-"
STASH_REF=""
STASH_LABEL=""

echo ""
echo -e "${CYAN}${BOLD}===============================================${NC}"
echo -e "${CYAN}${BOLD}   UPDATE PORTAL PELANGGAN GENIEACS${NC}"
echo -e "${CYAN}${BOLD}   Instance: ${INSTANCE_NAME}${NC}"
echo -e "${CYAN}${BOLD}===============================================${NC}"
echo ""

if [ "$EUID" -ne 0 ]; then
  echo -e "${YELLOW}[WARN]${NC} Jalankan dengan: ${BOLD}sudo bash update.sh${NC}"
  exit 1
fi

cd "$SCRIPT_DIR"

restore_runtime_data() {
  if [ -f "$BACKUP_ROOT/settings.runtime.json" ]; then
    cp -f "$BACKUP_ROOT/settings.runtime.json" "$SCRIPT_DIR/settings.local.json"
  fi
  if [ -d "$BACKUP_ROOT/database" ]; then
    rm -rf "$SCRIPT_DIR/database"
    cp -a "$BACKUP_ROOT/database" "$SCRIPT_DIR/database"
  fi
  if [ -d "$BACKUP_ROOT/auth_info_baileys" ]; then
    rm -rf "$SCRIPT_DIR/auth_info_baileys"
    cp -a "$BACKUP_ROOT/auth_info_baileys" "$SCRIPT_DIR/auth_info_baileys"
  fi
  if [ -d "$BACKUP_ROOT/logs" ]; then
    rm -rf "$SCRIPT_DIR/logs"
    cp -a "$BACKUP_ROOT/logs" "$SCRIPT_DIR/logs"
  fi
  if [ -d "$BACKUP_ROOT/public_uploads" ]; then
    mkdir -p "$SCRIPT_DIR/public"
    rm -rf "$SCRIPT_DIR/public/uploads"
    cp -a "$BACKUP_ROOT/public_uploads" "$SCRIPT_DIR/public/uploads"
  fi
}

rollback_source() {
  if [ -n "$PREV_HEAD" ]; then
    echo -e "${YELLOW}[ROLLBACK]${NC} Kembali ke commit sebelumnya: ${PREV_HEAD}"
    git reset --hard "$PREV_HEAD"
    restore_runtime_data
    npm install --no-audit --no-fund
    if [ -n "$STASH_REF" ]; then
      echo -e "${BLUE}[INFO]${NC} Mengembalikan perubahan source lokal dari ${STASH_REF}..."
      git stash pop "$STASH_REF" || echo -e "${YELLOW}[WARN]${NC} Stash ${STASH_REF} gagal dipulihkan otomatis. Cek manual dengan git stash list."
    fi
  fi
}

trap 'echo -e "${RED}[ERROR]${NC} Update gagal. Menjalankan rollback..."; rollback_source' ERR

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo -e "${RED}[ERROR]${NC} Folder ini bukan git repository."
  exit 1
fi

PREV_HEAD="$(git rev-parse --short HEAD)"
LOCAL_VERSION="$(cat version.txt 2>/dev/null || echo '-')"
BRANCH="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's#refs/remotes/origin/##' || true)"
if [ -z "$BRANCH" ]; then
  BRANCH="main"
fi

echo -e "${BLUE}[INFO]${NC} Branch: ${BRANCH}"
echo -e "${BLUE}[INFO]${NC} Commit server saat ini: ${PREV_HEAD}"
echo -e "${BLUE}[INFO]${NC} Versi server saat ini: ${LOCAL_VERSION}"

echo -e "${BLUE}[INFO]${NC} Mengambil info terbaru dari GitHub..."
git fetch --prune
REMOTE_HEAD="$(git rev-parse --short "origin/${BRANCH}")"
REMOTE_VERSION="$(git show "origin/${BRANCH}:version.txt" 2>/dev/null | tr -d '\r' || echo '-')"

echo -e "${BLUE}[INFO]${NC} Commit GitHub: ${REMOTE_HEAD}"
echo -e "${BLUE}[INFO]${NC} Versi GitHub: ${REMOTE_VERSION}"

if [ "$REMOTE_HEAD" = "$PREV_HEAD" ]; then
  echo -e "${GREEN}[OK]${NC} Source sudah terbaru. Tidak ada update yang perlu diterapkan."
  exit 0
fi

echo -e "${BLUE}[INFO]${NC} Membuat backup runtime..."
mkdir -p "$BACKUP_ROOT"
if [ -f "$SCRIPT_DIR/settings.local.json" ]; then
  cp "$SCRIPT_DIR/settings.local.json" "$BACKUP_ROOT/settings.runtime.json"
elif [ -f "$SCRIPT_DIR/settings.json" ]; then
  cp "$SCRIPT_DIR/settings.json" "$BACKUP_ROOT/settings.runtime.json"
fi
[ -d "$SCRIPT_DIR/database" ] && cp -a "$SCRIPT_DIR/database" "$BACKUP_ROOT/database"
[ -d "$SCRIPT_DIR/auth_info_baileys" ] && cp -a "$SCRIPT_DIR/auth_info_baileys" "$BACKUP_ROOT/auth_info_baileys"
[ -d "$SCRIPT_DIR/logs" ] && cp -a "$SCRIPT_DIR/logs" "$BACKUP_ROOT/logs"
[ -d "$SCRIPT_DIR/public/uploads" ] && cp -a "$SCRIPT_DIR/public/uploads" "$BACKUP_ROOT/public_uploads"

if [ -n "$(git status --porcelain)" ]; then
  STASH_LABEL="admin-self-update-$(date +%s)"
  echo -e "${BLUE}[INFO]${NC} Mengamankan perubahan source lokal ke stash: ${STASH_LABEL}"
  git stash push --include-untracked -m "$STASH_LABEL"
  STASH_REF="$(git stash list --format='%gd::%s' | awk -F'::' -v label="$STASH_LABEL" '$2==label{print $1; exit}')"
fi

echo -e "${BLUE}[INFO]${NC} Menarik source terbaru..."
git switch "$BRANCH" >/dev/null 2>&1 || git switch --track "origin/${BRANCH}"
git pull --ff-only origin "$BRANCH"

if [ "$REMOTE_VERSION" != "-" ]; then
  printf '%s\n' "$REMOTE_VERSION" > "$SCRIPT_DIR/version.txt"
fi

echo -e "${BLUE}[INFO]${NC} Mengembalikan data runtime yang dipreservasi..."
restore_runtime_data

echo -e "${BLUE}[INFO]${NC} Update dependensi npm..."
npm install --no-audit --no-fund

echo -e "${BLUE}[INFO]${NC} Menjalankan validasi source..."
node scripts/check-syntax.js
node scripts/smoke-render.js

echo -e "${BLUE}[INFO]${NC} Restart PM2 instance..."
if pm2 describe "$INSTANCE_NAME" >/dev/null 2>&1; then
  pm2 restart "$INSTANCE_NAME" --update-env
else
  echo -e "${YELLOW}[WARN]${NC} Proses PM2 ${INSTANCE_NAME} tidak ditemukan. Silakan restart manual."
fi

if command -v curl >/dev/null 2>&1; then
  SERVER_PORT="$(node -e "try{const s=require('./config/settingsManager').getSettings(); process.stdout.write(String(s.server_port || 3001));}catch(e){process.stdout.write('3001');}")"
  echo -e "${BLUE}[INFO]${NC} Health check port ${SERVER_PORT}..."
  curl -I -s "http://127.0.0.1:${SERVER_PORT}/admin/login" | head -n 1 || true
fi

trap - ERR

echo ""
echo -e "${GREEN}${BOLD}Update selesai!${NC}"
echo -e "Commit: ${YELLOW}${PREV_HEAD}${NC} -> ${YELLOW}${REMOTE_HEAD}${NC}"
if [ -n "$STASH_REF" ]; then
  echo -e "Perubahan source lokal lama diamankan di stash: ${YELLOW}${STASH_REF}${NC}"
fi
echo -e "Backup runtime: ${YELLOW}${BACKUP_ROOT}${NC}"
echo ""
