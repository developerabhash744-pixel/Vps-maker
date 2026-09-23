#!/usr/bin/env bash
# ==============================================================================
#  Custom VPS Discord Bot - Complete Server Host Setup Script
#  Supports: Ubuntu 22.04 / 24.04 / Debian 12 / Debian 13
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}"
echo "======================================================"
echo "    🚀 CUSTOM VPS DISCORD BOT HOST INSTALLER"
echo "======================================================"
echo -e "${NC}"

if [ "$(id -u)" -ne 0 ]; then
  echo -e "${RED}[!] Please run as root (sudo -i)${NC}"
  exit 1
fi

# 1. System packages
echo -e "${YELLOW}[+] Updating system packages...${NC}"
apt-get update -y
apt-get install -y curl git snapd btrfs-progs sqlite3

# Start snapd service if systemd is active
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now snapd.socket || true
  systemctl start snapd.service || true
  sleep 2
elif command -v service >/dev/null 2>&1; then
  service snapd start || true
  sleep 2
fi

# 2. Node.js LTS setup
if ! command -v node >/dev/null 2>&1; then
  echo -e "${YELLOW}[+] Installing Node.js LTS...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo -e "${GREEN}[✓] Node.js $(node -v) installed.${NC}"

# 3. LXD setup
if ! command -v lxd >/dev/null 2>&1; then
  echo -e "${YELLOW}[+] Installing LXD...${NC}"
  # Ensure snap core is initialized
  snap wait system seed.loaded || true
  snap install lxd || {
    echo -e "${YELLOW}[!] Retrying LXD install...${NC}"
    systemctl restart snapd || true
    sleep 3
    snap install lxd
  }
fi

export PATH="$PATH:/snap/bin"

echo -e "${YELLOW}[+] Initializing LXD...${NC}"
lxd init --auto || true

# 4. Install npm dependencies
echo -e "${YELLOW}[+] Installing Bot Dependencies...${NC}"
npm install
npm install -g pm2

# 5. Environment configuration
if [ ! -f .env ]; then
  echo -e "\n${BLUE}--- Bot Configuration ---${NC}"
  read -rp "Enter Discord Bot Token: " BOT_TOKEN
  read -rp "Enter Discord Application Client ID: " CLIENT_ID
  read -rp "Enter Discord Server (Guild) ID (optional, press enter to skip): " GUILD_ID
  read -rp "Enter Admin Discord User ID: " ADMIN_ID
  read -rp "Enter Hosting Brand Name (e.g. MyCloud): " BRAND_NAME
  [ -z "$BRAND_NAME" ] && BRAND_NAME="MyCloud"

  cat > .env <<EOF
DISCORD_TOKEN=${BOT_TOKEN}
CLIENT_ID=${CLIENT_ID}
GUILD_ID=${GUILD_ID}
ADMIN_IDS=${ADMIN_ID}
HOSTING_NAME="${BRAND_NAME}"
BRAND_COLOR="#5865F2"
DEFAULT_IMAGE="ubuntu:24.04"
EOF
  echo -e "${GREEN}[✓] .env configuration file generated.${NC}"
fi

# 6. Deploy slash commands
echo -e "${YELLOW}[+] Deploying Discord Slash Commands...${NC}"
node deploy-commands.js

# 7. Start bot with PM2
echo -e "${YELLOW}[+] Starting Bot with PM2...${NC}"
pm2 start index.js --name "vps-bot"
pm2 save
pm2 startup | tail -n 1 | bash || true

echo -e "\n${GREEN}======================================================"
echo " ✅ VPS Discord Bot is successfully installed and running!"
echo " Logs: pm2 logs vps-bot"
echo " Restart: pm2 restart vps-bot"
echo "======================================================${NC}"
