const https = require('https');
require('dotenv').config();

const token = (process.env.DISCORD_TOKEN || '').trim().replace(/^["']|["']$/g, '');

console.log('Testing Discord Token...');
console.log('Token length:', token.length);
console.log('Token preview:', token.substring(0, 10) + '...' + token.substring(token.length - 5));

const req = https.request(
  {
    hostname: 'discord.com',
    port: 443,
    path: '/api/v10/users/@me',
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
