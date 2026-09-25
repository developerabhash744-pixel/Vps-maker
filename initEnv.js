const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ENV_PATH = path.join(__dirname, '.env');

function askQuestion(rl, query, defaultValue = '') {
  return new Promise((resolve) => {
    const promptText = defaultValue ? `${query} [Default: ${defaultValue}]: ` : `${query}: `;
    rl.question(promptText, (answer) => {
      const trimmed = (answer || '').trim();
      resolve(trimmed || defaultValue);
    });
  });
}

async function ensureEnv() {
  // If .env exists, load it first
  if (fs.existsSync(ENV_PATH)) {
    require('dotenv').config({ path: ENV_PATH });
  }

  const hasToken = process.env.DISCORD_TOKEN && process.env.DISCORD_TOKEN.trim().length > 0;
  const hasClientId = process.env.CLIENT_ID && process.env.CLIENT_ID.trim().length > 0;

  // If already configured, we are good to go!
  if (hasToken && hasClientId) {
    return true;
  }

  // If terminal is not interactive (e.g. background worker without tty)
  if (!process.stdin.isTTY) {
    console.error('❌ Error: DISCORD_TOKEN or CLIENT_ID is missing and terminal is not interactive.');
    console.error('👉 Please create a .env file with DISCORD_TOKEN and CLIENT_ID.');
    process.exit(1);
  }

  console.log('\n======================================================');
  console.log('   🚀 NovaCloud VPS Discord Bot - Quick Setup Wizard');
  console.log('======================================================');
  console.log('It looks like your bot credentials are not configured yet.');
  console.log('Please answer the prompts below to configure your instance:\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    let token = '';
    while (!token) {
      token = await askQuestion(rl, '🤖 Enter your Discord Bot Token');
      if (!token) console.log('⚠️ Bot Token is required!');
    }

    let clientId = '';
    while (!clientId) {
      clientId = await askQuestion(rl, '🆔 Enter your Discord Application (Client) ID');
      if (!clientId) console.log('⚠️ Application Client ID is required!');
    }

    const guildId = await askQuestion(rl, '🏰 Enter Discord Server (Guild) ID (Press Enter for Global commands)', '');
    const adminId = await askQuestion(rl, '👑 Enter your Discord User ID for Admin Access (optional)', '');
    const hostingName = await askQuestion(rl, '🏷️ Enter Hosting Brand Name', 'NovaCloud');
    const proxyUrl = await askQuestion(rl, '🌐 Enter Discord Proxy / Cloudflare Worker URL (optional, press Enter to skip)', '');
    const serverIp = await askQuestion(rl, '🖥️ Enter Server Public IP (optional, press Enter for auto-detect)', '');

    rl.close();

    const envContent = [
      `# Discord Bot Credentials`,
      `DISCORD_TOKEN=${token.trim()}`,
      `CLIENT_ID=${clientId.trim()}`,
      `GUILD_ID=${guildId.trim()}`,
      ``,
      `# Admin & Branding`,
      `ADMIN_IDS=${adminId.trim()}`,
      `HOSTING_NAME="${hostingName.trim()}"`,
      `BRAND_COLOR="#5865F2"`,
      `DEFAULT_IMAGE="ubuntu:24.04"`,
      ``,
      `# Server & Proxy (Optional)`,
      `SERVER_IP="${serverIp.trim()}"`,
      `DISCORD_PROXY_URL="${proxyUrl.trim()}"`,
      ``,
    ].join('\n');

    fs.writeFileSync(ENV_PATH, envContent, 'utf8');
    console.log('\n✅ Configuration successfully saved to .env!\n');

    // Reload dotenv
    require('dotenv').config({ path: ENV_PATH, override: true });
    return true;
  } catch (err) {
    rl.close();
    console.error('Setup aborted:', err.message);
    process.exit(1);
  }
}

module.exports = { ensureEnv };
