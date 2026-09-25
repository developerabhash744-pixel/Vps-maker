const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

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

// Background Task: Expiration & Auto-Stop Watcher (runs every 15 minutes)
function checkExpirations() {
  try {
    const all = db.getAllVPS();
    const now = Date.now();
    for (const v of all) {
      if (v.expiresAt && v.expiresAt <= now) {
        const live = container.getInfo(v.containerName);
        if (live && live.status === 'Running') {
          console.log(`[Auto-Expire] Stopping expired VPS: ${v.containerName}`);
          container.stop(v.containerName);
        }
      }
    }
  } catch (err) {
    console.error('[Auto-Expire Watcher Error]:', err.message);
  }
}

// Check admin status
function checkIsAdmin(interaction, userId) {
  const isOwner = interaction.guild?.ownerId === userId;
  const hasAdminPerm =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator);
  return Boolean(isOwner || config.adminIds.includes(userId) || hasAdminPerm);
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

  // Run auto-expiration watcher every 15 minutes
  checkExpirations();
  setInterval(checkExpirations, 15 * 60 * 1000);
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

  // 2. Interactive Button Actions (Start, Stop, Restart, Backup, Delete)
  if (interaction.isButton()) {
    const customId = interaction.customId;
    if (!customId.startsWith('vps_btn_')) return;

    const parts = customId.split('_');
    const action = parts[2]; // 'start', 'stop', 'restart', 'backup', 'delete'
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

    await interaction.deferUpdate();

    try {
      if (action === 'start') {
        container.start(name);
      } else if (action === 'stop') {
        container.stop(name);
      } else if (action === 'restart') {
        container.restart(name);
      } else if (action === 'backup') {
        const backupResult = container.createBackup(name);
        const currentBackups = vpsRecord.backups || [];
        currentBackups.push(backupResult);
        db.setVPS(name, { ...vpsRecord, backups: currentBackups });
      } else if (action === 'delete') {
        container.delete(name);
        db.removeVPS(name);
        return interaction.editReply({
          content: `🗑️ **VPS \`${name}\` has been permanently deleted.**`,
          embeds: [],
          components: [],
        });
      }

      // Re-fetch state and update control panel embed & buttons
      setTimeout(async () => {
        try {
          const updatedRecord = db.getVPS(name) || vpsRecord;
          const live = container.getInfo(name);
          const isRunning = live?.status === 'Running';
          const planInfo = config.plans[updatedRecord.plan] || { name: updatedRecord.plan, cpu: '1', ram: '1GiB' };
          const templateInfo = config.templates[updatedRecord.template] || { name: 'Standard' };
          const expireStr = updatedRecord.expiresAt ? new Date(updatedRecord.expiresAt).toLocaleString() : 'Permanent';
          const exposed = (updatedRecord.exposedPorts || []).map((p) => `• Port \`${p.containerPort}\` ➔ \`${p.publicUrl}\``).join('\n') || 'None';
          const backups = (updatedRecord.backups || []).map((b) => `• \`${b.tag}\` (${new Date(b.timestamp).toLocaleDateString()})`).join('\n') || 'None';

          const embed = new EmbedBuilder()
            .setColor(isRunning ? '#00FF88' : '#FF4444')
            .setTitle(`📊 VPS Control Panel: ${name}`)
            .setDescription(`Use the interactive buttons below to manage your container power and snapshots in real time.`)
            .addFields(
              { name: 'Status', value: isRunning ? '🟢 Running' : '🔴 Stopped', inline: true },
              { name: 'Plan', value: `${planInfo.name} (${planInfo.cpu} vCPU, ${planInfo.ram})`, inline: true },
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
          if (updatedRecord.webTerminalUrl) {
            components.push(
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setLabel('🚀 Open Web Terminal')
                  .setURL(updatedRecord.webTerminalUrl)
                  .setStyle(ButtonStyle.Link)
              )
            );
          }

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
