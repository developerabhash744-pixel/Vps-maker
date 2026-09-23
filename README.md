# Custom Discord LXD VPS Hosting Bot

A modern, fast, and secure Discord bot built with **Node.js (Discord.js v14)** to manage **Ubuntu 24.04 / 22.04 LTS VPS containers** via LXD/LXC on Linux servers.

---

## 🚀 Features

- **Ubuntu 24.04 / 22.04 LTS**: Instant container provisioning with CPU & RAM limits.
- **Web Terminal (`sshx`)**: Users get direct browser terminal access with one click.
- **Resource Plans**: Pre-configured tiers (`free`, `bronze`, `silver`, `gold`).
- **Slash Commands**:
  - `/vps create <name> [plan] [os]` — Deploy a new VPS container.
  - `/vps list` — View all your active containers.
  - `/vps info <name>` — Live IP, memory usage, CPU stats.
  - `/vps terminal <name>` — Instant web terminal link.
  - `/vps start / stop / restart / delete <name>` — Full lifecycle controls.
  - `/admin list / force-delete / node-stats` — Host node management.
- **Dynamic Presence**: Live status showing the number of active running containers.
- **Self-Contained**: No reliance on third-party file hosts, zip mirrors, or hardcoded admin IDs.

---

## 🛠️ Quick Installation on Your VPS

Run this in your VPS terminal:

```bash
cd /root/custom-vps-bot
chmod +x setup.sh
./setup.sh
```

---

## ⚙️ Configuration (`.env`)

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
GUILD_ID=your_guild_id_here
ADMIN_IDS=your_discord_user_id
HOSTING_NAME="NovaCloud"
BRAND_COLOR="#5865F2"
DEFAULT_IMAGE="ubuntu:24.04"
```
