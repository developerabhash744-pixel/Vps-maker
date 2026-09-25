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

function checkIsAdmin(interaction, userId) {
  const isOwner = interaction.guild?.ownerId === userId;
  const hasAdminPerm =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator);
  return Boolean(isOwner || config.adminIds.includes(userId) || hasAdminPerm);
}

function buildControlButtons(name, isRunning = true) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vps_btn_start_${name}`)
      .setLabel('Start')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success)
      .setDisabled(isRunning),
    new ButtonBuilder()
      .setCustomId(`vps_btn_stop_${name}`)
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isRunning),
    new ButtonBuilder()
      .setCustomId(`vps_btn_restart_${name}`)
      .setLabel('Restart')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!isRunning),
    new ButtonBuilder()
      .setCustomId(`vps_btn_backup_${name}`)
      .setLabel('Snapshot')
      .setEmoji('📸')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`vps_btn_delete_${name}`)
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
  );
  return row;
}

module.exports = {
  buildControlButtons,
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
              { name: 'Gold [Admin] (8 CPU / 8GB RAM / 80GB Disk)', value: 'gold' }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('template')
            .setDescription('1-Click Pre-configured Software Template')
            .setRequired(false)
            .addChoices(
              { name: 'Clean Base OS (No extra packages)', value: 'none' },
              { name: 'Node.js LTS + PM2 + Yarn + PNPM', value: 'nodejs' },
              { name: 'Python 3 + Pip + Venv + Build Tools', value: 'python' },
              { name: 'Minecraft Server (Java 21 OpenJDK)', value: 'minecraft' },
              { name: 'Go Latest Toolchain + Build Tools', value: 'golang' },
              { name: 'Nginx Web Server', value: 'webserver' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List all your active VPS instances')
    )
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription('Show detailed information, control panel, and live stats of your VPS')
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
        .setName('renew')
        .setDescription('Renew / extend your VPS expiration date')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('expose')
        .setDescription('Forward / expose a container port to a public host port')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name').setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName('port').setDescription('Internal container port (e.g. 3000, 8080, 25565)').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('backup')
        .setDescription('Create an instant snapshot backup of your VPS')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('restore')
        .setDescription('Restore your VPS from a previous snapshot backup')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Container name').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('tag').setDescription('Backup tag to restore').setRequired(true)
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
    const isAdmin = checkIsAdmin(interaction, userId);

    // 1. CREATE
    if (sub === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const rawName = interaction.options.getString('name').trim().toLowerCase();
      const safeName = rawName.replace(/[^a-z0-9-]/g, '');

      if (!safeName || safeName.length < 3 || safeName.length > 20) {
        return interaction.editReply('❌ Container name must be 3-20 characters (alphanumeric and dashes only).');
      }

      // Quota limit check: Standard users are limited to config.maxVpsPerUser
      const userVpsCount = db.getUserVPSList(userId).length;
      if (!isAdmin && userVpsCount >= config.maxVpsPerUser) {
        return interaction.editReply(
          `❌ **Quota Limit Reached**: You already have ${userVpsCount} active VPS (Limit: ${config.maxVpsPerUser}). Delete an existing VPS before creating a new one.`
        );
      }

      // Check if container name is already taken in DB
      if (db.getVPS(safeName)) {
        return interaction.editReply(`❌ A VPS named \`${safeName}\` already exists. Please choose another name.`);
      }

      const planKey = interaction.options.getString('plan') || 'free';
      const plan = config.plans[planKey] || config.plans.free;

      // Admin-only plan security check
      if (plan.adminOnly && !isAdmin) {
        return interaction.editReply(
          `❌ The **${plan.name}** is reserved for server Administrators and VIPs. Please choose a standard plan (Free, Bronze, or Silver).`
        );
      }

      const osImage = interaction.options.getString('os') || config.defaultImage;
      const templateKey = interaction.options.getString('template') || 'none';
      const templateInfo = config.templates[templateKey] || config.templates.none;

      const progressEmbed = new EmbedBuilder()
        .setColor(config.brandColor)
        .setTitle(`🚀 Provisioning ${safeName}...`)
        .setDescription(
          `Creating your **${plan.name}** container using image \`${osImage}\`.\n` +
          `📦 **Template:** ${templateInfo.name}\n\n` +
          `*Allocating resources, hardening security sandbox, and initializing PTY terminal...*`
        )
        .setFooter({ text: config.hostingName });

      await interaction.editReply({ embeds: [progressEmbed] });

      try {
        const result = await container.createContainer({
          name: safeName,
          image: osImage,
          cpu: plan.cpu,
          ram: plan.ram,
          disk: plan.disk,
          templateKey,
        });

        // Save record to DB
        db.setVPS(safeName, {
          containerName: safeName,
          ownerId: userId,
          ownerTag: interaction.user.tag,
          plan: planKey,
          image: osImage,
          template: templateKey,
          sshPort: result.sshPort,
          webPort: result.webPort,
          webTerminalUrl: result.webTerminalUrl,
          createdAt: Date.now(),
          expiresAt: Date.now() + plan.durationDays * 24 * 60 * 60 * 1000,
          exposedPorts: [],
          backups: [],
        });

        const components = [];
        const btnRow = new ActionRowBuilder();
        if (result.webTerminalUrl) {
          btnRow.addComponents(
            new ButtonBuilder()
              .setLabel('🚀 Launch Web Terminal')
              .setURL(result.webTerminalUrl)
              .setStyle(ButtonStyle.Link)
          );
        }
        btnRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`vps_btn_restart_${safeName}`)
            .setLabel('Restart')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`vps_btn_stop_${safeName}`)
            .setLabel('Stop')
            .setEmoji('⏹️')
            .setStyle(ButtonStyle.Secondary)
        );
        components.push(btnRow);

        const expireDate = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000).toLocaleDateString();

        const successEmbed = new EmbedBuilder()
          .setColor('#00FF88')
          .setTitle(`✅ VPS Provisioned: ${safeName}`)
          .setDescription(`Your virtual server is online and fully secured!`)
          .addFields(
            { name: '📦 Container Name', value: `\`${safeName}\``, inline: true },
            { name: '⚡ Plan', value: `${plan.name} (${plan.cpu} vCPU, ${plan.ram} RAM)`, inline: true },
            { name: '💿 OS Image', value: `\`${osImage}\``, inline: true },
            { name: '🛠️ Template', value: `${templateInfo.name}`, inline: true },
            { name: '🔑 Username', value: '`root`', inline: true },
            { name: '🔒 Root Password', value: `\`${result.password}\``, inline: true },
            { name: '🔌 SSH Port', value: `\`${result.sshPort}\``, inline: true },
            { name: '📅 Expires On', value: `\`${expireDate}\``, inline: true },
            {
              name: '🌐 In-Browser Web Terminal',
              value: result.webTerminalUrl
                ? `[**Click here to open Web Terminal**](${result.webTerminalUrl})\n\`${result.webTerminalUrl}\``
                : 'Direct SSH available.',
              inline: false,
            },
            {
              name: '💻 Direct SSH Login',
              value: `\`ssh root@${result.hostIp} -p ${result.sshPort}\``,
              inline: false,
            }
          )
          .setFooter({ text: `${config.hostingName} • Keep your credentials safe!` });

        let dmSent = false;
        try {
          await interaction.user.send({ embeds: [successEmbed], components });
          dmSent = true;
        } catch (e) {
          console.warn('Could not send DM to user:', e.message);
        }

        if (dmSent) {
          const publicNoticeEmbed = new EmbedBuilder()
            .setColor('#00FF88')
            .setTitle(`✅ VPS Provisioned: ${safeName}`)
            .setDescription(
              `Your virtual server **\`${safeName}\`** is online!\n\n` +
              `📩 **All root login credentials and private terminal links have been sent to your Direct Messages (DMs).**`
            )
            .setFooter({ text: `${config.hostingName} • Check your DMs` });
          return interaction.editReply({ embeds: [publicNoticeEmbed], components: [] });
        } else {
          return interaction.editReply({
            content: '⚠️ *Could not send you a Direct Message (your DMs might be closed). Here are your credentials privately:*',
            embeds: [successEmbed],
            components,
          });
        }
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
        .setTitle(`🖥️ Your VPS Containers (${vpsList.length}/${config.maxVpsPerUser})`)
        .setFooter({ text: config.hostingName });

      vpsList.forEach((v) => {
        const live = container.getInfo(v.containerName);
        const status = live ? live.status : 'Offline';
        const emoji = status === 'Running' ? '🟢' : '🔴';
        const expireStr = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString() : 'Never';
        embed.addFields({
          name: `${emoji} ${v.containerName}`,
          value: `**Plan:** ${config.plans[v.plan]?.name || v.plan}\n**Status:** ${status}\n**Expires:** ${expireStr}\n**SSH Port:** \`${v.sshPort || '22'}\``,
          inline: true,
        });
      });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // Container-level operations: Check ownership / admin privileges
    const name = interaction.options.getString('name');
    const vpsRecord = db.getVPS(name);

    if (!vpsRecord) {
      return interaction.reply({ content: `❌ VPS \`${name}\` not found in database.`, flags: MessageFlags.Ephemeral });
    }

    if (vpsRecord.ownerId !== userId && !isAdmin) {
      return interaction.reply({ content: `❌ You do not own this VPS.`, flags: MessageFlags.Ephemeral });
    }

    // 3. INFO & CONTROL PANEL
    if (sub === 'info') {
      const live = container.getInfo(name);
      const isRunning = live?.status === 'Running';
      const expireStr = vpsRecord.expiresAt ? new Date(vpsRecord.expiresAt).toLocaleString() : 'Permanent';
      const planInfo = config.plans[vpsRecord.plan] || { name: vpsRecord.plan, cpu: '1', ram: '1GiB' };
      const templateInfo = config.templates[vpsRecord.template] || { name: 'Standard' };
      const exposed = (vpsRecord.exposedPorts || []).map((p) => `• Port \`${p.containerPort}\` ➔ \`${p.publicUrl}\``).join('\n') || 'None';
      const backups = (vpsRecord.backups || []).map((b) => `• \`${b.tag}\` (${new Date(b.timestamp).toLocaleDateString()})`).join('\n') || 'None';

      const embed = new EmbedBuilder()
        .setColor(isRunning ? '#00FF88' : '#FF4444')
        .setTitle(`📊 VPS Control Panel: ${name}`)
        .setDescription(`Use the interactive buttons below to manage your container power and snapshots in real time.`)
        .addFields(
          { name: 'Status', value: isRunning ? '🟢 Running' : '🔴 Stopped', inline: true },
          { name: 'Plan', value: `${planInfo.name} (${planInfo.cpu} vCPU, ${planInfo.ram})`, inline: true },
          { name: 'Template', value: `${templateInfo.name}`, inline: true },
          { name: 'Internal IP', value: `\`${live?.ipv4 || 'None'}\``, inline: true },
          { name: 'SSH Port', value: `\`${vpsRecord.sshPort || live?.sshPort || '22'}\``, inline: true },
          { name: 'Memory', value: `\`${live?.memoryUsage || '0 MB'}\``, inline: true },
          { name: 'Owner', value: `<@${vpsRecord.ownerId}>`, inline: true },
          { name: 'Expires', value: `${expireStr}`, inline: true },
          { name: 'OS Image', value: `\`${vpsRecord.image || 'ubuntu'}\``, inline: true },
          { name: '🌐 Forwarded Ports', value: exposed, inline: false },
          { name: '📸 Snapshots & Backups', value: backups, inline: false }
        )
        .setFooter({ text: `${config.hostingName} • Interactive Control Panel` });

      const components = [buildControlButtons(name, isRunning)];
      if (vpsRecord.webTerminalUrl) {
        components.push(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel('🚀 Open Web Terminal')
              .setURL(vpsRecord.webTerminalUrl)
              .setStyle(ButtonStyle.Link)
          )
        );
      }

      return interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
    }

    // 4. TERMINAL
    if (sub === 'terminal') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const link = await container.createWebTerminal(name);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('🚀 Launch Web Terminal').setURL(link).setStyle(ButtonStyle.Link)
        );

        const embed = new EmbedBuilder()
          .setColor('#00FF88')
          .setTitle(`💻 Web Terminal: ${name}`)
          .setDescription(
            `Your interactive browser terminal session is ready!\n\n` +
            `🔗 **Link:** [Click to open terminal](${link})\n\`${link}\`\n\n` +
            `⚠️ **Security Notice:** Do not share this link. It provides direct root shell access to your container.`
          )
          .setFooter({ text: config.hostingName });

        let dmSent = false;
        try {
          await interaction.user.send({ embeds: [embed], components: [row] });
          dmSent = true;
        } catch (e) {
          console.warn('Could not send DM to user:', e.message);
        }

        if (dmSent) {
          return interaction.editReply({
            content: `📩 **Web terminal link for \`${name}\` has been sent privately to your DMs.**`,
            embeds: [],
            components: [],
          });
        } else {
          return interaction.editReply({ embeds: [embed], components: [row] });
        }
      } catch (err) {
        return interaction.editReply(`❌ Could not open terminal: ${err.message}`);
      }
    }

    // 5. START
    if (sub === 'start') {
      try {
        container.start(name);
        return interaction.reply({ content: `🟢 Started container \`${name}\`.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to start: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // 6. STOP
    if (sub === 'stop') {
      try {
        container.stop(name);
        return interaction.reply({ content: `🛑 Stopped container \`${name}\`.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to stop: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // 7. RESTART
    if (sub === 'restart') {
      try {
        container.restart(name);
        return interaction.reply({ content: `🔄 Restarting container \`${name}\`...`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to restart: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // 8. RENEW
    if (sub === 'renew') {
      const plan = config.plans[vpsRecord.plan] || config.plans.free;
      const durationMs = (plan.durationDays || 7) * 24 * 60 * 60 * 1000;
      const currentExpiry = vpsRecord.expiresAt && vpsRecord.expiresAt > Date.now() ? vpsRecord.expiresAt : Date.now();
      const newExpiry = currentExpiry + durationMs;

      db.setVPS(name, { ...vpsRecord, expiresAt: newExpiry });
      return interaction.reply({
        content: `✅ VPS \`${name}\` renewed successfully! New expiration date: **${new Date(newExpiry).toLocaleDateString()}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // 9. EXPOSE PORT
    if (sub === 'expose') {
      const targetPort = interaction.options.getInteger('port');
      if (targetPort < 1 || targetPort > 65535) {
        return interaction.reply({ content: '❌ Invalid port number (must be 1-65535).', flags: MessageFlags.Ephemeral });
      }

      try {
        const exposedResult = container.exposePort(name, targetPort);
        const currentExposed = vpsRecord.exposedPorts || [];
        currentExposed.push(exposedResult);
        db.setVPS(name, { ...vpsRecord, exposedPorts: currentExposed });

        return interaction.reply({
          content: `🌐 **Port Forwarded Successfully!**\n\nContainer Port: \`${targetPort}\`\nPublic Host Port: \`${exposedResult.hostPort}\`\nPublic URL: \`${exposedResult.publicUrl}\``,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        return interaction.reply({ content: `❌ Port forwarding failed: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // 10. BACKUP / SNAPSHOT
    if (sub === 'backup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const backupResult = container.createBackup(name);
        const currentBackups = vpsRecord.backups || [];
        currentBackups.push(backupResult);
        db.setVPS(name, { ...vpsRecord, backups: currentBackups });

        return interaction.editReply(`📸 **Snapshot Created Successfully!**\nBackup Tag: \`${backupResult.tag}\``);
      } catch (err) {
        return interaction.editReply(`❌ Backup failed: ${err.message}`);
      }
    }

    // 11. RESTORE
    if (sub === 'restore') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const tag = interaction.options.getString('tag');
      try {
        container.restoreBackup(name, tag);
        return interaction.editReply(`🔄 **Restored \`${name}\` from backup \`${tag}\` successfully!**`);
      } catch (err) {
        return interaction.editReply(`❌ Restore failed: ${err.message}`);
      }
    }

    // 12. DELETE
    if (sub === 'delete') {
      try {
        container.delete(name);
        db.removeVPS(name);
        return interaction.reply({ content: `🗑️ Permanently deleted VPS \`${name}\`.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to delete: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }
  },
};
