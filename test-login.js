const https = require('https');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
require('dotenv').config();

const token = (process.env.DISCORD_TOKEN || '').trim().replace(/^["']|["']$/g, '');
const proxyUrl = (process.env.DISCORD_PROXY_URL || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');

console.log('Testing Discord Token...');
console.log('Token length:', token.length);
console.log('Proxy URL:', proxyUrl || 'None (Direct)');

let targetHostname = 'discord.com';
let targetPort = 443;
let targetPath = '/api/v10/users/@me';

if (proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    targetHostname = parsed.hostname;
    targetPort = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
    targetPath = `${parsed.pathname.replace(/\/+$/, '')}/api/v10/users/@me`;
  } catch (err) {
    console.warn('Invalid proxy URL format, defaulting to discord.com');
  }
}

const req = https.request(
  {
    hostname: targetHostname,
    port: targetPort,
    path: targetPath,
    method: 'GET',
    headers: {
      Authorization: `Bot ${token}`,
      'User-Agent': 'DiscordBot (https://github.com/developerabhash744-pixel/Vps-maker, 1.0.0)',
    },
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      console.log('HTTP Status Code:', res.statusCode);
      try {
        const json = JSON.parse(data);
        if (res.statusCode === 200) {
          console.log(`✅ Token is VALID! Bot User: ${json.username}#${json.discriminator} (ID: ${json.id})`);
        } else {
          console.log('❌ Discord API Error Response:', json);
        }
      } catch {
        console.log('Raw response:', data);
      }
    });
  }
);

req.on('error', (e) => {
  console.error('❌ Connection error to discord.com:', e.message);
});

req.end();
