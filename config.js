require('dotenv').config();

module.exports = {
  token: (process.env.DISCORD_TOKEN || '').trim().replace(/^["']|["']$/g, ''),
  clientId: (process.env.CLIENT_ID || '').trim().replace(/^["']|["']$/g, ''),
  guildId: (process.env.GUILD_ID || '').trim().replace(/^["']|["']$/g, '') || null,
  proxyUrl: (process.env.DISCORD_PROXY_URL || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, ''),
  adminIds: (process.env.ADMIN_IDS || '').split(',').map((id) => id.trim()).filter(Boolean),
  hostingName: process.env.HOSTING_NAME || 'NovaCloud',
  brandColor: process.env.BRAND_COLOR || '#5865F2',
  defaultImage: process.env.DEFAULT_IMAGE || 'ubuntu:24.04',

  // Pre-configured resource plans
  plans: {
    free: {
      name: 'Free Starter',
      cpu: '1',
      ram: '1GiB',
      disk: '10GiB',
      durationDays: 7,
    },
    bronze: {
      name: 'Bronze Plan',
      cpu: '2',
      ram: '2GiB',
      disk: '20GiB',
      durationDays: 30,
    },
    silver: {
      name: 'Silver Plan',
      cpu: '4',
      ram: '4GiB',
      disk: '40GiB',
      durationDays: 30,
    },
    gold: {
      name: 'Gold Plan',
      cpu: '8',
      ram: '8GiB',
      disk: '80GiB',
      durationDays: 30,
    },
  },
};
