const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { Client, GatewayIntentBits, ActivityType, Collection, Events } = require('discord.js');
const config = require('./config');
const db = require('./database');
const container = require('./containerManager');
const vpsCommand = require('./commands/vps');
const adminCommand = require('./commands/admin');

if (!config.token) {
  console.error('❌ Error: DISCORD_TOKEN is missing in .env file!');
  process.exit(1);
}

const clientOptions = {
  intents: [GatewayIntentBits.Guilds],
};

if (config.proxyUrl) {
  const wsGateway = config.proxyUrl.replace(/^http/, 'ws');
  clientOptions.rest = { api: `${config.proxyUrl}/api` };
  clientOptions.ws = { gateway: wsGateway };
}

const client = new Client(clientOptions);

client.on('error', (err) => console.error('[Discord Client Error]:', err.message));
client.on('shardError', (err) => console.warn('[Discord Shard Error]:', err.message));

// Command registry
client.commands = new Collection();
client.commands.set(vpsCommand.data.name, vpsCommand);
client.commands.set(adminCommand.data.name, adminCommand);

// Dynamic presence updater
function updatePresence() {
  try {
    const all = db.getAllVPS();
    const running = all.filter((v) => container.getInfo(v.containerName)?.status === 'Running').length;
    client.user.setPresence({
      status: 'online',
      activities: [
        {
          name: `${running} Active VPS | /vps`,
          type: ActivityType.Watching,
        },
      ],
    });
  } catch (err) {
    console.error('[Presence] Error:', err.message);
  }
}

// Ready event
client.once(Events.ClientReady, () => {
  console.log(`=========================================`);
  console.log(`🚀 ${config.hostingName} Bot is ONLINE!`);
  console.log(`🤖 Logged in as: ${client.user.tag}`);
  console.log(`📦 Container Backend: ${container.isAvailable() ? `${container.engine} (Connected)` : 'Not detected'}`);
  console.log(`=========================================`);

  updatePresence();
  setInterval(updatePresence, 20 * 1000);
});

// Interaction handler
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`[Command Error] /${interaction.commandName}:`, error);
    const replyMethod = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
    try {
      await interaction[replyMethod]({
        content: `❌ An unexpected error occurred: ${error.message}`,
        ephemeral: true,
      });
    } catch {}
  }
});

client.login(config.token);
