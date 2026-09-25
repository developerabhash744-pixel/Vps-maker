const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const container = require('../containerManager');
const db = require('../database');
const config = require('../config');

function checkIsAdmin(interaction, userId) {
  const isOwner = interaction.guild?.ownerId === userId;
  const isConfigAdmin = config.adminIds.includes(userId);
  const hasAdminPerm =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator);
  return Boolean(isOwner || isConfigAdmin || hasAdminPerm);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Administrator controls and host management')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    // 1. STATS
    .addSubcommand((sub) =>
      sub.setName('stats').setDescription('View host hardware performance and health')
    )
    // 2. LIST
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List all VPS containers across the entire system')
    )
    // 3. BROADCAST
    .addSubcommand((sub) =>
      sub
        .setName('broadcast')
        .setDescription('Send a maintenance or announcement DM to all VPS owners')
        .addStringOption((opt) => opt.setName('message').setDescription('Message to broadcast').setRequired(true))
    )
    // 4. RESET PASSWORD
    .addSubcommand((sub) =>
      sub
        .setName('reset-password')
        .setDescription('Force-reset the root password for a container')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addStringOption((opt) => opt.setName('password').setDescription('New password (optional)').setRequired(false))
    )
    // 5. PURGE
    .addSubcommand((sub) =>
      sub.setName('purge').setDescription('Purge expired containers that passed the 48-hour grace period')
    )
    // 6. FORCE DELETE
    .addSubcommand((sub) =>
      sub
        .setName('force-delete')
        .setDescription('Force delete any container from host and database')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    if (!checkIsAdmin(interaction, userId)) {
      return interaction.reply({ content: '❌ You do not have permission to use admin commands.', flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand();

    // 1. STATS
    if (sub === 'stats') {
      const stats = container.getHostStats();
      const embed = new EmbedBuilder()
        .setColor(config.brandColor)
        .setTitle('👑 Host Hardware Status & Telemetry')
        .addFields(
          { name: '🖥️ CPU Cores', value: `${stats.cpuCount} (Load: ${stats.loadAvg})`, inline: true },
          { name: '🧠 Host RAM', value: `\`[${stats.memBar}]\`\n${stats.usedMem} / ${stats.totalMem}`, inline: true },
          { name: '💾 Disk Space', value: `\`${stats.diskInfo}\``, inline: true },
          { name: '⏱️ Host Uptime', value: `${stats.uptime}`, inline: true },
          { name: '📦 Containers', value: `**${stats.runningVPS}** Running / **${stats.totalVPS}** Total`, inline: true },
          { name: '🌐 Host IP', value: `\`${stats.publicIp}\``, inline: true },
          { name: '🔧 Backend Engine', value: container.isAvailable() ? `🟢 ${container.engine} Connected` : '🔴 Offline', inline: true }
        )
        .setFooter({ text: `${config.hostingName} • Node Admin Monitor` });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // 2. LIST
    if (sub === 'list') {
      const allVPS = db.getAllVPS();
      if (allVPS.length === 0) {
        return interaction.reply({ content: 'No VPS containers found in database.', flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setColor('#FFAA00')
        .setTitle(`👑 Global Containers Overview (${allVPS.length})`)
        .setFooter({ text: config.hostingName });

      allVPS.forEach((v) => {
        const live = container.getInfo(v.containerName);
        const status = live ? live.status : 'Stopped';
        const emoji = status === 'Running' ? '🟢' : '🔴';
        const expireStr = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString() : 'Never';
        embed.addFields({
          name: `${emoji} ${v.containerName}`,
          value: `**Owner:** <@${v.ownerId}>\n**Plan:** ${v.plan}\n**Status:** ${status}\n**Expires:** ${expireStr}\n**Port:** \`${v.sshPort || '22'}\``,
          inline: true,
        });
      });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // 3. BROADCAST
    if (sub === 'broadcast') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const broadcastMsg = interaction.options.getString('message');
      const allVPS = db.getAllVPS();
      const uniqueOwnerIds = [...new Set(allVPS.map((v) => v.ownerId))];

      let sentCount = 0;
      let failCount = 0;

      const embed = new EmbedBuilder()
        .setColor('#FFAA00')
        .setTitle(`📢 Important Notice from ${config.hostingName}`)
        .setDescription(broadcastMsg)
        .setFooter({ text: 'Official Host Administrator Broadcast' })
        .setTimestamp();

      for (const ownerId of uniqueOwnerIds) {
        try {
          const user = await interaction.client.users.fetch(ownerId);
          if (user) {
            await user.send({ embeds: [embed] });
            sentCount++;
          }
        } catch {
          failCount++;
        }
      }

      return interaction.editReply(
        `📢 **Broadcast complete!** Sent to **${sentCount} users** (${failCount} failed / DMs closed).`
      );
    }

    // 4. RESET PASSWORD
    if (sub === 'reset-password') {
      const name = interaction.options.getString('name');
      const customPass = interaction.options.getString('password');
      try {
        const newPassword = container.resetPassword(name, customPass);
        return interaction.reply({
          content: `🔑 **Password Reset for \`${name}\`:** \`${newPassword}\``,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        return interaction.reply({ content: `❌ Password reset failed: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // 5. PURGE EXPIRED
    if (sub === 'purge') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const allVPS = db.getAllVPS();
      const now = Date.now();
      const gracePeriodMs = (config.gracePeriodHours || 48) * 60 * 60 * 1000;
      let purgedCount = 0;

      for (const v of allVPS) {
        if (v.expiresAt && now - v.expiresAt > gracePeriodMs) {
          try { container.delete(v.containerName); } catch {}
          db.removeVPS(v.containerName);
          purgedCount++;
        }
      }

      return interaction.editReply(`🧹 **Purge Complete!** Removed **${purgedCount} expired containers** past grace period.`);
    }

    // 6. FORCE DELETE
    if (sub === 'force-delete') {
      const name = interaction.options.getString('name');
      try {
        container.delete(name);
      } catch {}
      db.removeVPS(name);
      return interaction.reply({ content: `✅ Admin force-deleted \`${name}\`.`, flags: MessageFlags.Ephemeral });
    }
  },
};
