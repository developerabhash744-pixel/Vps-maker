const { Client, GatewayIntentBits, ActivityType, Collection } = require('discord.js');
const config = require('./config');
const db = require('./database');
const container = require('./containerManager');
const vpsCommand = require('./commands/vps');
const adminCommand = require('./commands/admin');

if (!config.token) {
  console.error('❌ Error: DISCORD_TOKEN is missing in .env file!');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

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
client.once('ready', () => {
  console.log(`=========================================`);
  console.log(`🚀 ${config.hostingName} Bot is ONLINE!`);
  console.log(`🤖 Logged in as: ${client.user.tag}`);
  console.log(`📦 LXD Backend: ${lxd.isAvailable() ? 'Connected' : 'Not detected'}`);
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
