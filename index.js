const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { ensureEnv } = require('./initEnv');

async function bootstrap() {
  await ensureEnv();

  const {
    Client,
    GatewayIntentBits,
    ActivityType,
    Collection,
    Events,
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
  } = require('discord.js');
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
    clientOptions.rest = { api: `${config.proxyUrl}/api` };
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

  // Background Daemon: Expiration, Automated DM Reminders & Auto-Purge
  async function checkExpirationsAndReminders() {
    try {
      const all = db.getAllVPS();
      const now = Date.now();
      const oneHourMs = 60 * 60 * 1000;
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      const gracePeriodMs = (config.gracePeriodHours || 48) * 60 * 60 * 1000;

      for (const v of all) {
        if (!v.expiresAt) continue;
        const timeLeft = v.expiresAt - now;

        // 1. 24-Hour Warning DM
        if (timeLeft > 0 && timeLeft <= twentyFourHoursMs && !v.warned24h) {
          try {
            const user = await client.users.fetch(v.ownerId);
            if (user) {
              const embed = new EmbedBuilder()
                .setColor('#FFAA00')
                .setTitle(`⚠️ VPS Expiration Notice: ${v.containerName}`)
                .setDescription(
                  `Your virtual server **\`${v.containerName}\`** will expire in **24 hours**.\n\n` +
                  `Click the **Renew VPS** button below or run \`/vps renew ${v.containerName}\` to keep your server running without data loss.`
                )
                .setFooter({ text: `${config.hostingName} • Expiration Reminder` });

              const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`vps_btn_renew_${v.containerName}`)
                  .setLabel('🔄 Renew VPS (+7 Days)')
                  .setStyle(ButtonStyle.Success)
              );

              await user.send({ embeds: [embed], components: [row] });
              db.setVPS(v.containerName, { ...v, warned24h: true });
            }
          } catch {}
        }

        // 2. 1-Hour Critical Warning DM
        if (timeLeft > 0 && timeLeft <= oneHourMs && !v.warned1h) {
          try {
            const user = await client.users.fetch(v.ownerId);
            if (user) {
              const embed = new EmbedBuilder()
                .setColor('#FF4444')
                .setTitle(`🚨 Urgent: VPS Expiring in 1 Hour (${v.containerName})`)
                .setDescription(
                  `Your container **\`${v.containerName}\`** is about to expire and stop.\n` +
                  `Renew immediately to prevent downtime!`
                )
                .setFooter({ text: `${config.hostingName} • Urgent Reminder` });

              const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`vps_btn_renew_${v.containerName}`)
                  .setLabel('🔄 Renew VPS Now')
                  .setStyle(ButtonStyle.Success)
              );

              await user.send({ embeds: [embed], components: [row] });
              db.setVPS(v.containerName, { ...v, warned1h: true });
            }
          } catch {}
        }

        // 3. Expired: Auto-Stop
        if (timeLeft <= 0) {
          const live = container.getInfo(v.containerName);
          if (live && live.status === 'Running') {
            console.log(`[Auto-Expire] Stopping expired container: ${v.containerName}`);
            container.stop(v.containerName);
          }

          // 4. Past Grace Period: Auto-Purge to reclaim host disk space
          if (now - v.expiresAt > gracePeriodMs) {
            console.log(`[Auto-Purge] Deleting expired container past grace period: ${v.containerName}`);
            try { container.delete(v.containerName); } catch {}
            db.removeVPS(v.containerName);
          }
        }
      }
    } catch (err) {
      console.error('[Daemon Error]:', err.message);
    }
  }

  function checkIsAdmin(interaction, userId) {
    const isOwner = interaction.guild?.ownerId === userId;
    const isConfigAdmin = config.adminIds.includes(userId);
    const hasAdminPerm =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator);
    return Boolean(isOwner || isConfigAdmin || hasAdminPerm);
  }

  // Ready event
  client.once(Events.ClientReady, () => {
    console.log(`=========================================`);
    console.log(`🚀 ${config.hostingName} Bot is ONLINE!`);
    console.log(`🤖 Logged in as: ${client.user.tag}`);
    console.log(`📦 Container Backend: ${container.isAvailable() ? `${container.engine} (Connected)` : 'Not detected'}`);
    console.log(`=========================================`);

    // Auto-connect worker bridges for any running containers
    try {
      const all = db.getAllVPS();
      all.forEach((v) => {
        const live = container.getInfo(v.containerName);
        if (live && live.status === 'Running') {
          container.createWorkerBridge(v.containerName);
        }
      });
    } catch (e) {
      console.warn('[Startup Tunnel Init]:', e.message);
    }

    updatePresence();
    setInterval(updatePresence, 30 * 1000);

    // Background expiration daemon every 15 minutes
    checkExpirationsAndReminders();
    setInterval(checkExpirationsAndReminders, 15 * 60 * 1000);
  });

  // Interaction handler (Commands & Interactive Buttons)
  client.on('interactionCreate', async (interaction) => {
    // 1. Slash Commands
    if (interaction.isChatInputCommand()) {
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
            flags: MessageFlags.Ephemeral,
          });
        } catch {}
      }
      return;
    }

    // 2. Interactive Button Actions
    if (interaction.isButton()) {
      const customId = interaction.customId;
      if (!customId.startsWith('vps_btn_')) return;

      const parts = customId.split('_');
      const action = parts[2]; // 'start', 'stop', 'restart', 'stats', 'delete', 'renew'
      const name = parts.slice(3).join('_');
      const userId = interaction.user.id;
      const isAdmin = checkIsAdmin(interaction, userId);

      const vpsRecord = db.getVPS(name);
      if (!vpsRecord) {
        return interaction.reply({ content: `❌ VPS \`${name}\` not found.`, flags: MessageFlags.Ephemeral });
      }

      if (vpsRecord.ownerId !== userId && !isAdmin) {
        return interaction.reply({ content: `❌ You do not own this VPS.`, flags: MessageFlags.Ephemeral });
      }

      if (action === 'renew') {
        const plan = config.plans[vpsRecord.plan] || config.plans.free;
        const durationMs = (plan.durationDays || 7) * 24 * 60 * 60 * 1000;
        const currentExpiry = vpsRecord.expiresAt && vpsRecord.expiresAt > Date.now() ? vpsRecord.expiresAt : Date.now();
        const newExpiry = currentExpiry + durationMs;

        db.setVPS(name, { ...vpsRecord, expiresAt: newExpiry, warned24h: false, warned1h: false });
        return interaction.reply({
          content: `✅ **Renewed Successfully!** VPS \`${name}\` is extended until **${new Date(newExpiry).toLocaleDateString()}**.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // Apply server invite booster
      if (action === 'applyboost') {
        const invitesCount = await vpsCommand.fetchUserInvites(interaction.guild, userId);
        const boostInfo = vpsCommand.calculateBoostTier(invitesCount);

        try {
          container.updateContainerResources(name, boostInfo.ram, boostInfo.cpu);
          db.setVPS(name, {
            ...vpsRecord,
            ram: boostInfo.ram,
            cpu: boostInfo.cpu,
            disk: boostInfo.disk,
            boostTier: boostInfo.tierName,
          });

          return interaction.reply({
            content:
              `⚡ **Invite Boost Applied!**\n\n` +
              `Container: \`${name}\`\n` +
              `Server Invites: **${invitesCount} Joins**\n` +
              `Unlocked Tier: **${boostInfo.tierName}**\n` +
              `New Specs: **${boostInfo.ram} RAM • ${boostInfo.cpu} vCPU • ${boostInfo.disk} Disk**`,
            flags: MessageFlags.Ephemeral,
          });
        } catch (err) {
          return interaction.reply({ content: `❌ Failed to update container specs: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
      }

      if (action === 'stats') {
        const stats = container.getLiveStats(name);
        if (!stats) {
          return interaction.reply({ content: `⚠️ Could not fetch stats. Ensure \`${name}\` is running.`, flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
          .setColor('#00FF88')
          .setTitle(`📈 Live Metrics: ${name}`)
          .addFields(
            { name: '⚡ CPU Utilization', value: `\`[${stats.cpuBar}]\` **${stats.cpuPercentStr}**`, inline: false },
            { name: '🧠 RAM Usage', value: `\`[${stats.memBar}]\` **${stats.memUsageStr} (${stats.memPercentStr})**`, inline: false },
            { name: '📶 Network Traffic', value: `\`${stats.netIO}\``, inline: true },
            { name: '💾 Disk I/O', value: `\`${stats.blockIO}\``, inline: true },
            { name: '⚙️ Active PIDs', value: `\`${stats.pids}\``, inline: true }
          )
          .setFooter({ text: `${config.hostingName} • Live Container Telemetry` });

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate();

      try {
        if (action === 'start') {
          container.start(name);
        } else if (action === 'stop') {
          container.stop(name);
        } else if (action === 'restart') {
          container.restart(name);
        } else if (action === 'delete') {
          container.delete(name);
          db.removeVPS(name);
          return interaction.editReply({
            content: `🗑️ **VPS \`${name}\` has been permanently deleted.**`,
            embeds: [],
            components: [],
          });
        }

        setTimeout(async () => {
          try {
            const updatedRecord = db.getVPS(name) || vpsRecord;
            const live = container.getInfo(name);
            const isRunning = live?.status === 'Running';
            const planInfo = config.plans[updatedRecord.plan] || { name: updatedRecord.plan, cpu: '1', ram: '1GiB' };
            const templateInfo = config.templates[updatedRecord.template] || { name: 'Standard' };
            const expireStr = updatedRecord.expiresAt ? new Date(updatedRecord.expiresAt).toLocaleString() : 'Permanent';
            const exposed = (updatedRecord.exposedPorts || []).map((p) => `• Port \`${p.containerPort}\` (${p.protocol}) ➔ \`${p.publicUrl}\``).join('\n') || 'None';
            const backups = (updatedRecord.backups || []).map((b) => `• \`${b.tag}\` (${new Date(b.timestamp).toLocaleDateString()})`).join('\n') || 'None';

            const embed = new EmbedBuilder()
              .setColor(isRunning ? '#00FF88' : '#FF4444')
              .setTitle(`📊 VPS Control Panel: ${name}`)
              .setDescription(`Use the interactive buttons below to manage your container power and snapshots in real time.`)
              .addFields(
                { name: 'Status', value: isRunning ? '🟢 Running' : '🔴 Stopped', inline: true },
                { name: 'Allocated Specs', value: `**${updatedRecord.ram || '32GiB'} RAM • ${updatedRecord.cpu || '1'} vCPU**`, inline: true },
                { name: 'Booster Tier', value: `${updatedRecord.boostTier || 'Base Free Starter'}`, inline: true },
                { name: 'Template', value: `${templateInfo.name}`, inline: true },
                { name: 'Internal IP', value: `\`${live?.ipv4 || 'None'}\``, inline: true },
                { name: 'SSH Port', value: `\`${updatedRecord.sshPort || live?.sshPort || '22'}\``, inline: true },
                { name: 'Memory', value: `\`${live?.memoryUsage || '0 MB'}\``, inline: true },
                { name: 'Owner', value: `<@${updatedRecord.ownerId}>`, inline: true },
                { name: 'Expires', value: `${expireStr}`, inline: true },
                { name: 'OS Image', value: `\`${updatedRecord.image || 'ubuntu'}\``, inline: true },
                { name: '🌐 Forwarded Ports', value: exposed, inline: false },
                { name: '📸 Snapshots & Backups', value: backups, inline: false }
              )
              .setFooter({ text: `${config.hostingName} • Interactive Control Panel` });

            const components = [vpsCommand.buildControlButtons(name, isRunning)];
            const actionRow2 = new ActionRowBuilder();
            if (updatedRecord.webTerminalUrl) {
              actionRow2.addComponents(
                new ButtonBuilder()
                  .setLabel('🚀 Open Web Terminal')
                  .setURL(updatedRecord.webTerminalUrl)
                  .setStyle(ButtonStyle.Link)
              );
            }
            actionRow2.addComponents(
              new ButtonBuilder()
                .setCustomId(`vps_btn_applyboost_${name}`)
                .setLabel('⚡ Claim Invite Boost')
                .setStyle(ButtonStyle.Success)
            );
            components.push(actionRow2);

            await interaction.editReply({ embeds: [embed], components });
          } catch (e) {
            console.warn('[Button refresh error]:', e.message);
          }
        }, 1000);
      } catch (err) {
        console.error(`[Button Action Error ${action}]:`, err.message);
      }
    }
  });

  client.login(config.token);
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
