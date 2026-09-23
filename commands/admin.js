const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const lxd = require('../lxdManager');
const db = require('../database');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Administrator controls for the VPS host')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List all VPS containers running on the host')
    )
    .addSubcommand((sub) =>
      sub
        .setName('force-delete')
        .setDescription('Force delete any container from host and DB')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('node-stats').setDescription('View host server health, RAM, and CPU')
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    if (!config.adminIds.includes(userId) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ You do not have permission to use admin commands.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const allVPS = db.getAllVPS();
      if (allVPS.length === 0) {
        return interaction.reply({ content: 'No VPS containers found in database.', ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setColor('#FFAA00')
        .setTitle(`👑 Admin Overview — All Containers (${allVPS.length})`)
        .setFooter({ text: config.hostingName });

      allVPS.forEach((v) => {
        const live = lxd.getInfo(v.containerName);
        const status = live ? live.status : 'Missing / Stopped';
        embed.addFields({
          name: `${status === 'Running' ? '🟢' : '🔴'} ${v.containerName}`,
          value: `**Owner:** <@${v.ownerId}>\n**Plan:** ${v.plan}\n**Status:** ${status}`,
          inline: true,
        });
      });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'force-delete') {
      const name = interaction.options.getString('name');
      try {
        lxd.delete(name);
      } catch {}
      db.removeVPS(name);
      return interaction.reply({ content: `✅ Admin force-deleted \`${name}\`.`, ephemeral: true });
    }

    if (sub === 'node-stats') {
      const allVPS = db.getAllVPS();
      const runningCount = allVPS.filter((v) => lxd.getInfo(v.containerName)?.status === 'Running').length;

      const embed = new EmbedBuilder()
        .setColor(config.brandColor)
        .setTitle('📈 Host Node Status')
        .addFields(
          { name: 'Total Provisioned VPS', value: `${allVPS.length}`, inline: true },
          { name: 'Active Running Containers', value: `${runningCount}`, inline: true },
          { name: 'LXD Status', value: lxd.isAvailable() ? '🟢 Online' : '🔴 Offline', inline: true }
        )
        .setFooter({ text: config.hostingName });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
