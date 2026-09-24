#!/usr/bin/env bash
# ==============================================================================
#  Custom VPS Discord Bot - Universal Setup Script
#  Supports: Containerized hosts, Docker, Ubuntu, Debian
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}"
echo "======================================================"
echo "    🚀 UNIVERSAL VPS DISCORD BOT HOST INSTALLER"
echo "======================================================"
echo -e "${NC}"

if [ "$(id -u)" -ne 0 ]; then
  echo -e "${RED}[!] Please run as root (sudo -i)${NC}"
  exit 1
fi

# 1. System packages
echo -e "${YELLOW}[+] Updating system packages...${NC}"
apt-get update -y
apt-get install -y curl git sqlite3 procps net-tools

# Install sshx for web terminal
if ! command -v sshx >/dev/null 2>&1; then
  echo -e "${YELLOW}[+] Installing sshx web terminal...${NC}"
  curl -sSf https://sshx.io/get | sh -s -- -y 2>/dev/null || curl -sSf https://sshx.io/get | bash 2>/dev/null || true
fi

# 2. Setup Container Engine (Docker)
if ! command -v docker >/dev/null 2>&1; then
  echo -e "${YELLOW}[+] Installing Docker container engine...${NC}"
  apt-get install -y docker.io || {
    curl -fsSL https://get.docker.com | sh
  }
fi

# Start docker daemon using service if systemctl is not available
if command -v systemctl >/dev/null 2>&1; then
  systemctl start docker || true
elif command -v service >/dev/null 2>&1; then
  service docker start || true
elif [ -x /etc/init.d/docker ]; then
  /etc/init.d/docker start || true
fi

# Pre-pull Ubuntu 24.04 image so VPS creation is instant
echo -e "${YELLOW}[+] Pulling Ubuntu 24.04 base image (cache)...${NC}"
docker pull ubuntu:24.04 || true

# 3. Node.js LTS setup
if ! command -v node >/dev/null 2>&1; then
  echo -e "${YELLOW}[+] Installing Node.js LTS...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo -e "${GREEN}[✓] Node.js $(node -v) installed.${NC}"

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

echo -e "\n${GREEN}======================================================"
echo " ✅ VPS Discord Bot is successfully installed and running!"
echo " Logs: pm2 logs vps-bot"
echo " Restart: pm2 restart vps-bot"
echo "======================================================${NC}"
