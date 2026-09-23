const { REST, Routes } = require('discord.js');
const config = require('./config');
const vpsCommand = require('./commands/vps');
const adminCommand = require('./commands/admin');

if (!config.token || !config.clientId) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID in .env file!');
  process.exit(1);
}

const commands = [vpsCommand.data.toJSON(), adminCommand.data.toJSON()];
const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    console.log(`[Slash Commands] Registering ${commands.length} application commands...`);

    if (config.guildId) {
      // Guild-specific (instant update)
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
        body: commands,
      });
      console.log(`[Slash Commands] Successfully registered commands to Guild ID: ${config.guildId}`);
    } else {
      // Global commands
      await rest.put(Routes.applicationCommands(config.clientId), {
        body: commands,
      });
      console.log(`[Slash Commands] Successfully registered global commands.`);
    }
  } catch (error) {
    console.error('[Slash Commands] Error registering commands:', error);
  }
})();
