const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const container = require('../containerManager');
const db = require('../database');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vps')
    .setDescription('Manage your virtual private server (VPS)')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a new VPS container')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name (lowercase, no spaces)').setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('os')
            .setDescription('Operating System')
            .setRequired(false)
            .addChoices(
              { name: 'Ubuntu 24.04 LTS (Latest)', value: 'ubuntu:24.04' },
              { name: 'Ubuntu 22.04 LTS', value: 'ubuntu:22.04' },
              { name: 'Debian 12 Bookworm', value: 'images:debian/12' }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('plan')
            .setDescription('Resource Plan')
            .setRequired(false)
            .addChoices(
              { name: 'Free Starter (1 CPU / 1GB RAM / 10GB Disk)', value: 'free' },
              { name: 'Bronze (2 CPU / 2GB RAM / 20GB Disk)', value: 'bronze' },
              { name: 'Silver (4 CPU / 4GB RAM / 40GB Disk)', value: 'silver' },
              { name: 'Gold (8 CPU / 8GB RAM / 80GB Disk)', value: 'gold' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List all your active VPS instances')
    )
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription('Show detailed information and live stats of your VPS')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('terminal')
        .setDescription('Get a secure web browser terminal link for your VPS')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start a stopped VPS')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('stop')
        .setDescription('Stop a running VPS')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('restart')
        .setDescription('Restart your VPS')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Permanently delete your VPS')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name').setRequired(true)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // 1. CREATE
    if (sub === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const rawName = interaction.options.getString('name').trim().toLowerCase();
      const safeName = rawName.replace(/[^a-z0-9-]/g, '');

      if (!safeName || safeName.length < 3 || safeName.length > 20) {
        return interaction.editReply('❌ Container name must be 3-20 characters (alphanumeric and dashes only).');
      }

      // Check if name is already taken
      if (db.getVPS(safeName)) {
        return interaction.editReply(`❌ A VPS named \`${safeName}\` already exists. Please choose another name.`);
      }

      const planKey = interaction.options.getString('plan') || 'free';
      const plan = config.plans[planKey] || config.plans.free;
      const osImage = interaction.options.getString('os') || config.defaultImage;

      const progressEmbed = new EmbedBuilder()
        .setColor(config.brandColor)
        .setTitle(`🚀 Provisioning ${safeName}...`)
        .setDescription(`Creating your **${plan.name}** container using image \`${osImage}\`.\nThis usually takes 10-20 seconds.`)
        .setFooter({ text: config.hostingName });

      await interaction.editReply({ embeds: [progressEmbed] });

      try {
        const result = await container.createContainer({
          name: safeName,
          image: osImage,
          cpu: plan.cpu,
          ram: plan.ram,
          disk: plan.disk,
        });

        // Save to DB
        db.setVPS(safeName, {
          containerName: safeName,
          ownerId: userId,
          ownerTag: interaction.user.tag,
          plan: planKey,
          image: osImage,
          sshPort: result.sshPort,
          createdAt: Date.now(),
          expiresAt: Date.now() + plan.durationDays * 24 * 60 * 60 * 1000,
        });

        const successEmbed = new EmbedBuilder()
          .setColor('#00FF88')
          .setTitle(`✅ VPS Created: ${safeName}`)
          .setDescription(`Your virtual server is now online and ready to use!`)
          .addFields(
            { name: '📦 Container Name', value: `\`${safeName}\``, inline: true },
            { name: '⚡ Plan', value: `${plan.name} (${plan.cpu} vCPU, ${plan.ram} RAM)`, inline: true },
            { name: '💿 OS Image', value: `\`${osImage}\``, inline: true },
            { name: '🔑 Username', value: '`root`', inline: true },
            { name: '🔒 Root Password', value: `\`${result.password}\``, inline: true },
            { name: '🔌 SSH Port', value: `\`${result.sshPort}\``, inline: true },
            { name: '🌐 In-Browser Terminal', value: `Use \`/vps terminal name:${safeName}\` to open your browser terminal.`, inline: false }
          )
          .setFooter({ text: `${config.hostingName} • Keep your password safe!` });

        return interaction.editReply({ embeds: [successEmbed] });
      } catch (err) {
        return interaction.editReply(`❌ Creation failed: ${err.message}`);
      }
    }

    // 2. LIST
    if (sub === 'list') {
      const vpsList = db.getUserVPSList(userId);
      if (vpsList.length === 0) {
        return interaction.reply({
          content: 'You do not have any active VPS containers. Use `/vps create` to deploy one!',
          flags: MessageFlags.Ephemeral,
        });
      }

      const embed = new EmbedBuilder()
        .setColor(config.brandColor)
        .setTitle(`🖥️ Your VPS Containers (${vpsList.length})`)
        .setFooter({ text: config.hostingName });

      vpsList.forEach((v) => {
        const live = container.getInfo(v.containerName);
        const status = live ? live.status : 'Offline';
        const emoji = status === 'Running' ? '🟢' : '🔴';
        embed.addFields({
          name: `${emoji} ${v.containerName}`,
          value: `**Plan:** ${config.plans[v.plan]?.name || v.plan}\n**Status:** ${status}\n**IP:** \`${live?.ipv4 || 'N/A'}\``,
          inline: true,
        });
      });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // Check ownership for single-container subcommands
    const name = interaction.options.getString('name');
    const vpsRecord = db.getVPS(name);

    if (!vpsRecord) {
      return interaction.reply({ content: `❌ VPS \`${name}\` not found in database.`, flags: MessageFlags.Ephemeral });
    }

    const isOwner = interaction.guild?.ownerId === userId;
    const hasAdminPerm =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator);
    const isAdmin = isOwner || config.adminIds.includes(userId) || hasAdminPerm;

    if (vpsRecord.ownerId !== userId && !isAdmin) {
      return interaction.reply({ content: `❌ You do not own this VPS.`, flags: MessageFlags.Ephemeral });
    }

    // 3. INFO
    if (sub === 'info') {
      const live = container.getInfo(name);
      const embed = new EmbedBuilder()
        .setColor(config.brandColor)
        .setTitle(`📊 VPS Info: ${name}`)
        .addFields(
          { name: 'Status', value: live ? live.status : 'Stopped / Unknown', inline: true },
          { name: 'Internal IP', value: `\`${live?.ipv4 || 'None'}\``, inline: true },
          { name: 'SSH Port', value: `\`${vpsRecord.sshPort || live?.sshPort || '22'}\``, inline: true },
          { name: 'Memory Usage', value: `\`${live?.memoryUsage || '0 MB'}\``, inline: true },
          { name: 'Owner', value: `<@${vpsRecord.ownerId}>`, inline: true },
          { name: 'Plan', value: `${config.plans[vpsRecord.plan]?.name || vpsRecord.plan}`, inline: true },
          { name: 'Image', value: `\`${vpsRecord.image || 'ubuntu'}\``, inline: true }
        )
        .setFooter({ text: config.hostingName });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // 4. TERMINAL (Web sshx)
    if (sub === 'terminal') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const link = await container.createWebTerminal(name);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Open Web Terminal').setURL(link).setStyle(ButtonStyle.Link)
        );

        const embed = new EmbedBuilder()
          .setColor('#00FF88')
          .setTitle(`💻 Web Terminal: ${name}`)
          .setDescription(`Your direct browser terminal session is ready.\n\n⚠️ **Note:** Do not share this link with anyone else.`)
          .setFooter({ text: config.hostingName });

        return interaction.editReply({ embeds: [embed], components: [row] });
      } catch (err) {
        return interaction.editReply(`❌ Could not open terminal: ${err.message}`);
      }
    }

    // 5. START
    if (sub === 'start') {
      try {
        container.start(name);
        return interaction.reply({ content: `🟢 Started \`${name}\`.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to start: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // 6. STOP
    if (sub === 'stop') {
      try {
        container.stop(name);
        return interaction.reply({ content: `🛑 Stopped \`${name}\`.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to stop: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // 7. RESTART
    if (sub === 'restart') {
      try {
        container.restart(name);
        return interaction.reply({ content: `🔄 Restarted \`${name}\`.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to restart: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // 8. DELETE
    if (sub === 'delete') {
      try {
        container.delete(name);
        db.removeVPS(name);
        return interaction.reply({ content: `🗑️ Permanently deleted \`${name}\`.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to delete: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }
  },
};
