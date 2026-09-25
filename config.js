require('dotenv').config();

module.exports = {
  token: (process.env.DISCORD_TOKEN || '').trim().replace(/^["']|["']$/g, ''),
  clientId: (process.env.CLIENT_ID || '').trim().replace(/^["']|["']$/g, ''),
  guildId: (process.env.GUILD_ID || '').trim().replace(/^["']|["']$/g, '') || null,
  proxyUrl: (process.env.DISCORD_PROXY_URL || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, ''),
  serverIp: (process.env.SERVER_IP || '').trim().replace(/^["']|["']$/g, '') || null,
  ngrokAuthToken: (process.env.NGROK_AUTHTOKEN || '').trim().replace(/^["']|["']$/g, '') || null,
  adminIds: (process.env.ADMIN_IDS || '').split(',').map((id) => id.trim()).filter(Boolean),
  hostingName: process.env.HOSTING_NAME || 'NovaCloud',
  brandColor: process.env.BRAND_COLOR || '#5865F2',
  defaultImage: process.env.DEFAULT_IMAGE || 'ubuntu:24.04',

  // Security & Quotas
  maxVpsPerUser: parseInt(process.env.MAX_VPS_PER_USER, 10) || 1,
  pidsLimit: parseInt(process.env.PIDS_LIMIT, 10) || 250,
  gracePeriodHours: 48, // Auto-purge containers stopped & expired > 48 hours

  // Base Free Plan for Every Member
  plans: {
    free: {
      name: 'Free Starter Plan',
      cpu: '1',
      ram: '32GiB',
      disk: '16GiB',
      durationDays: 30,
      adminOnly: false,
    },
  },

  // Invite-Based Extension Tiers (Cumulative / Milestone Upgrades)
  inviteBoosters: [
    {
      minInvites: 2,
      name: 'Tier 1 Boost (2 Invites)',
      ramBoostGiB: 5,     // +5GB RAM -> 37GB Total
      cpuBoost: 1,        // +1 Core -> 2 Cores Total
      diskBoostGiB: 5,    // +5GB Disk -> 21GB Total
    },
    {
      minInvites: 12,
      name: 'Tier 2 Boost (12 Invites)',
      ramBoostGiB: 40,    // +40GB RAM -> 72GB Total
      cpuBoost: 2,        // +2 Cores -> 3 Cores Total
      diskBoostGiB: 20,   // +20GB Disk -> 36GB Total
    },
    {
      minInvites: 20,
      name: 'Tier 3 Boost (20 Invites)',
      ramBoostGiB: 50,    // +50GB RAM -> 82GB Total
      cpuBoost: 4,        // +4 Cores -> 5 Cores Total
      diskBoostGiB: 32,   // +32GB Disk -> 48GB Total
    },
    {
      minInvites: 30,
      name: 'Tier 4 Max Boost (30 Invites)',
      ramBoostGiB: 64,    // +64GB RAM -> 96GB Total
      cpuBoost: 12,       // +12 Cores -> 13 Cores Total
      diskBoostGiB: 40,   // +40GB Disk -> 56GB Total
    },
  ],

  // Economy & Coins
  dailyRewardCoins: 50,
  costs: {
    renew7Days: 100,
  },

  // Dangerous commands blacklist for in-discord /vps exec
  commandBlacklist: [
    ':(){ :|:& };:',
    'mkfs',
    'dd if=/dev/zero',
    'dd if=/dev/random',
    'chmod -R 777 /',
    '> /dev/sda',
    '> /dev/vda',
    'rm -rf --no-preserve-root /',
  ],

  // 1-Click Application Templates
  templates: {
    none: {
      name: 'Clean Base OS',
      description: 'Standard Linux environment',
      script: '',
    },
    nodejs: {
      name: 'Node.js LTS & PM2',
      description: 'Node.js v20, npm, yarn, pnpm, pm2',
      script: 'curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs git && npm install -g pm2 yarn pnpm',
    },
    python: {
      name: 'Python 3 Environment',
      description: 'Python 3, pip, venv, build tools',
      script: 'apt-get install -y python3 python3-pip python3-venv git build-essential',
    },
    minecraft: {
      name: 'Minecraft Server Ready',
      description: 'OpenJDK 21, Screen, Wget, Curl',
      script: 'apt-get install -y openjdk-21-jre-headless screen curl wget',
    },
    golang: {
      name: 'Go Development Suite',
      description: 'Go compiler toolchain, git, build-essential',
      script: 'apt-get install -y golang git build-essential',
    },
    webserver: {
      name: 'Nginx Web Server',
      description: 'Nginx HTTP Server, curl, git',
      script: 'apt-get install -y nginx curl git && (service nginx start || true)',
    },
  },
};
