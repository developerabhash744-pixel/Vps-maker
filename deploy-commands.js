const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { ensureEnv } = require('./initEnv');

(async () => {
  await ensureEnv();

  const { REST, Routes } = require('discord.js');
  const config = require('./config');
  const vpsCommand = require('./commands/vps');
  const adminCommand = require('./commands/admin');

  if (!config.token || !config.clientId) {
    console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID!');
    process.exit(1);
  }

  const commands = [vpsCommand.data.toJSON(), adminCommand.data.toJSON()];
  const restOptions = { version: '10' };
  if (config.proxyUrl) {
    restOptions.api = `${config.proxyUrl}/api`;
  }
  const rest = new REST(restOptions).setToken(config.token);

  try {
    console.log(`[Slash Commands] Registering ${commands.length} application commands...`);

    if (config.guildId) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
        body: commands,
      });
      console.log(`[Slash Commands] Successfully registered commands to Guild ID: ${config.guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(config.clientId), {
        body: commands,
      });
      console.log(`[Slash Commands] Successfully registered global commands.`);
    }
  } catch (error) {
    console.error('[Slash Commands] Error registering commands:', error);
  }
})();
