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

  // Economy & Coins
  dailyRewardCoins: 50,
  costs: {
    renew7Days: 100,
    upgradeBronze: 250,
    upgradeSilver: 500,
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

  // Resource Plans
  plans: {
    free: {
      name: 'Free Starter',
      cpu: '1',
      ram: '1GiB',
      disk: '10GiB',
      durationDays: 7,
      adminOnly: false,
    },
    bronze: {
      name: 'Bronze Plan',
      cpu: '2',
      ram: '2GiB',
      disk: '20GiB',
      durationDays: 30,
      adminOnly: false,
    },
    silver: {
      name: 'Silver Plan',
      cpu: '4',
      ram: '4GiB',
      disk: '40GiB',
      durationDays: 30,
      adminOnly: false,
    },
    gold: {
      name: 'Gold Plan (Admin / VIP)',
      cpu: '8',
      ram: '8GiB',
      disk: '80GiB',
      durationDays: 60,
      adminOnly: true,
    },
  },

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
