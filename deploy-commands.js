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
      try {
        await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
          body: commands,
        });
        console.log(`✅ [Slash Commands] Successfully registered commands to Guild ID: ${config.guildId}`);
        return;
      } catch (err) {
        if (err.code === 50001 || err.status === 403) {
          console.warn(`⚠️ [Guild Access Warning]: Bot is not in guild ${config.guildId} or lacks application.commands scope.`);
          console.log(`ℹ️ Falling back to Global Command Registration...`);
        } else {
          throw err;
        }
      }
    }

    await rest.put(Routes.applicationCommands(config.clientId), {
      body: commands,
    });
    console.log(`✅ [Slash Commands] Successfully registered global application commands!`);
  } catch (error) {
    console.error('❌ [Slash Commands] Error registering commands:', error.message || error);
    console.log(`\n👉 Make sure your bot is invited with the 'applications.commands' scope:`);
    console.log(`https://discord.com/oauth2/authorize?client_id=${config.clientId}&permissions=8&scope=bot%20applications.commands\n`);
  }
})();
