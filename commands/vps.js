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
      .setCustomId(`vps_btn_stats_${name}`)
      .setLabel('Stats')
      .setEmoji('📊')
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
    .setDescription('Complete Virtual Private Server (VPS) Management')
    // 1. CREATE
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
    // 2. LIST
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List all your active VPS instances')
    )
    // 3. INFO
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription('Show detailed information, control panel, and live stats of your VPS')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    // 4. STATS
    .addSubcommand((sub) =>
      sub
        .setName('stats')
        .setDescription('View real-time CPU, RAM, Disk, and Network I/O metrics')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    // 5. TERMINAL
    .addSubcommand((sub) =>
      sub
        .setName('terminal')
        .setDescription('Get a secure web browser terminal link for your VPS')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    // 6. EXEC
    .addSubcommand((sub) =>
      sub
        .setName('exec')
        .setDescription('Execute a quick bash command inside your container')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addStringOption((opt) => opt.setName('command').setDescription('Bash command to execute').setRequired(true))
    )
    // 7. LOGS
    .addSubcommand((sub) =>
      sub
        .setName('logs')
        .setDescription('View the latest system / console output logs')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addIntegerOption((opt) => opt.setName('lines').setDescription('Number of lines (default: 30)').setRequired(false))
    )
    // 8. SSH KEY
    .addSubcommand((sub) =>
      sub
        .setName('sshkey')
        .setDescription('Add your SSH public key for passwordless terminal login')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addStringOption((opt) => opt.setName('key').setDescription('Your public key (ssh-rsa / ssh-ed25519)').setRequired(true))
    )
    // 9. START, STOP, RESTART, DELETE
    .addSubcommand((sub) =>
      sub.setName('start').setDescription('Start a stopped VPS')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('Stop a running VPS')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub.setName('restart').setDescription('Restart your VPS')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub.setName('delete').setDescription('Permanently delete your VPS')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    // 10. RENEW
    .addSubcommand((sub) =>
      sub.setName('renew').setDescription('Renew / extend your VPS expiration date')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    // 11. REBUILD
    .addSubcommand((sub) =>
      sub.setName('rebuild').setDescription('Factory reset your VPS with a fresh OS image')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('os').setDescription('New OS image (optional)').setRequired(false)
            .addChoices(
              { name: 'Ubuntu 24.04 LTS (Latest)', value: 'ubuntu:24.04' },
              { name: 'Ubuntu 22.04 LTS', value: 'ubuntu:22.04' },
              { name: 'Debian 12 Bookworm', value: 'images:debian/12' }
            )
        )
    )
    // 12. EXPOSE PORT
    .addSubcommand((sub) =>
      sub
        .setName('expose')
        .setDescription('Forward / expose a container port to a public host port')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addIntegerOption((opt) => opt.setName('port').setDescription('Internal port (e.g. 3000, 8080, 25565)').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('protocol').setDescription('Protocol (TCP or UDP)').setRequired(false)
            .addChoices({ name: 'TCP (Web / SSH / API)', value: 'tcp' }, { name: 'UDP (Game / Voice)', value: 'udp' })
        )
    )
    // 13. BACKUP & RESTORE
    .addSubcommand((sub) =>
      sub.setName('backup').setDescription('Create an instant snapshot backup of your VPS')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub.setName('restore').setDescription('Restore your VPS from a previous snapshot backup')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addStringOption((opt) => opt.setName('tag').setDescription('Backup tag to restore').setRequired(true))
    )
    // 14. UPGRADE PLAN
    .addSubcommand((sub) =>
      sub.setName('upgrade').setDescription('Upgrade your VPS resource plan')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('plan').setDescription('Target Plan').setRequired(true)
            .addChoices(
              { name: 'Bronze Plan (2 CPU / 2GB RAM / 250 Coins)', value: 'bronze' },
              { name: 'Silver Plan (4 CPU / 4GB RAM / 500 Coins)', value: 'silver' }
            )
        )
    )
    // 15. ECONOMY & REWARDS
    .addSubcommand((sub) => sub.setName('daily').setDescription('Claim your daily 50 coins reward'))
    .addSubcommand((sub) => sub.setName('economy').setDescription('Check your coin balance & economy profile'))
    .addSubcommand((sub) => sub.setName('leaderboard').setDescription('View top coin holders in the server')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const isAdmin = checkIsAdmin(interaction, userId);

    // =========================================================================
    // Economy Commands: /vps daily, /vps economy, /vps leaderboard
    // =========================================================================
    if (sub === 'daily') {
      const user = db.getUser(userId);
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;

      if (user.lastDaily && now - user.lastDaily < oneDayMs) {
        const remainingHours = Math.ceil((oneDayMs - (now - user.lastDaily)) / (60 * 60 * 1000));
        return interaction.reply({
          content: `⏳ You have already claimed your daily reward. Come back in **${remainingHours} hours**!`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const reward = config.dailyRewardCoins || 50;
      const newBal = db.addCoins(userId, reward);
      db.updateUser(userId, { lastDaily: now });

      return interaction.reply({
        content: `🎉 **Daily Claimed!** You received **+${reward} coins**!\n💰 Current Balance: **${newBal} coins**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'economy') {
      const user = db.getUser(userId);
      const userVPS = db.getUserVPSList(userId);

      const embed = new EmbedBuilder()
        .setColor('#FFAA00')
        .setTitle(`💰 Economy Profile: ${interaction.user.username}`)
        .addFields(
          { name: '🪙 Coin Balance', value: `**${user.coins || 0} Coins**`, inline: true },
          { name: '🖥️ Active VPS', value: `**${userVPS.length} Containers**`, inline: true },
          { name: '🎁 Daily Reward', value: '`/vps daily` (50 Coins)', inline: true },
          { name: '🛍️ Store Costs', value: `• 7-Day Renewal: **${config.costs.renew7Days} Coins**\n• Bronze Upgrade: **${config.costs.upgradeBronze} Coins**\n• Silver Upgrade: **${config.costs.upgradeSilver} Coins**`, inline: false }
        )
        .setFooter({ text: config.hostingName });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'leaderboard') {
      const top = db.getLeaderboard();
      const embed = new EmbedBuilder()
        .setColor(config.brandColor)
        .setTitle('🏆 Top Coin Holders')
        .setDescription(
          top
            .map((u, idx) => `**#${idx + 1}** <@${u.userId}> — **${u.coins} coins**`)
            .join('\n') || 'No users yet.'
        )
        .setFooter({ text: config.hostingName });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // =========================================================================
    // 1. CREATE
    // =========================================================================
    if (sub === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const rawName = interaction.options.getString('name').trim().toLowerCase();
      const safeName = rawName.replace(/[^a-z0-9-]/g, '');

      if (!safeName || safeName.length < 3 || safeName.length > 20) {
        return interaction.editReply('❌ Container name must be 3-20 characters (alphanumeric and dashes only).');
      }

      const userVpsCount = db.getUserVPSList(userId).length;
      if (!isAdmin && userVpsCount >= config.maxVpsPerUser) {
        return interaction.editReply(
          `❌ **Quota Limit Reached**: You already have ${userVpsCount} active VPS (Limit: ${config.maxVpsPerUser}). Delete an existing VPS before creating a new one.`
        );
      }

      if (db.getVPS(safeName)) {
        return interaction.editReply(`❌ A VPS named \`${safeName}\` already exists. Please choose another name.`);
      }

      const planKey = interaction.options.getString('plan') || 'free';
      const plan = config.plans[planKey] || config.plans.free;

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
            new ButtonBuilder().setLabel('🚀 Launch Web Terminal').setURL(result.webTerminalUrl).setStyle(ButtonStyle.Link)
          );
        }
        btnRow.addComponents(
          new ButtonBuilder().setCustomId(`vps_btn_restart_${safeName}`).setLabel('Restart').setEmoji('🔄').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`vps_btn_stop_${safeName}`).setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Secondary)
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

    // =========================================================================
    // 2. LIST
    // =========================================================================
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

    // =========================================================================
    // 3. INFO & CONTROL PANEL
    // =========================================================================
    if (sub === 'info') {
      const live = container.getInfo(name);
      const isRunning = live?.status === 'Running';
      const expireStr = vpsRecord.expiresAt ? new Date(vpsRecord.expiresAt).toLocaleString() : 'Permanent';
      const planInfo = config.plans[vpsRecord.plan] || { name: vpsRecord.plan, cpu: '1', ram: '1GiB' };
      const templateInfo = config.templates[vpsRecord.template] || { name: 'Standard' };
      const exposed = (vpsRecord.exposedPorts || []).map((p) => `• Port \`${p.containerPort}\` (${p.protocol}) ➔ \`${p.publicUrl}\``).join('\n') || 'None';
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
            new ButtonBuilder().setLabel('🚀 Open Web Terminal').setURL(vpsRecord.webTerminalUrl).setStyle(ButtonStyle.Link)
          )
        );
      }

      return interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
    }

    // =========================================================================
    // 4. STATS (Live ASCII Progress Bars)
    // =========================================================================
    if (sub === 'stats') {
      const stats = container.getLiveStats(name);
      if (!stats) {
        return interaction.reply({
          content: `⚠️ Could not fetch live stats for \`${name}\`. Ensure the container is running.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const embed = new EmbedBuilder()
        .setColor('#00FF88')
        .setTitle(`📈 Live Metrics: ${name}`)
        .addFields(
          {
            name: '⚡ CPU Utilization',
            value: `\`[${stats.cpuBar}]\` **${stats.cpuPercentStr}**`,
            inline: false,
          },
          {
            name: '🧠 RAM Usage',
            value: `\`[${stats.memBar}]\` **${stats.memUsageStr} (${stats.memPercentStr})**`,
            inline: false,
          },
          { name: '📶 Network Traffic', value: `\`${stats.netIO}\``, inline: true },
          { name: '💾 Disk I/O', value: `\`${stats.blockIO}\``, inline: true },
          { name: '⚙️ Active PIDs', value: `\`${stats.pids}\``, inline: true }
        )
        .setFooter({ text: `${config.hostingName} • Live Container Telemetry` });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // =========================================================================
    // 5. EXEC (Quick Remote Runner)
    // =========================================================================
    if (sub === 'exec') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const cmd = interaction.options.getString('command');

      try {
        const result = await container.execCommand(name, cmd);
        const output = result.stdout || result.stderr || '(No output produced)';
        const safeOutput = output.length > 1800 ? output.substring(0, 1800) + '\n...[Output truncated]' : output;

        const embed = new EmbedBuilder()
          .setColor(result.exitCode === 0 ? '#00FF88' : '#FF4444')
          .setTitle(`💻 Exec: \`${cmd}\``)
          .setDescription(`\`\`\`bash\n${safeOutput}\n\`\`\``)
          .setFooter({ text: `Exit Code: ${result.exitCode} • Executed in ${result.duration}ms` });

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply(`❌ Execution error: ${err.message}`);
      }
    }

    // =========================================================================
    // 6. LOGS
    // =========================================================================
    if (sub === 'logs') {
      const lines = interaction.options.getInteger('lines') || 30;
      const logs = container.getLogs(name, lines);
      const safeLogs = logs.length > 1900 ? logs.substring(logs.length - 1900) : logs;

      const embed = new EmbedBuilder()
        .setColor(config.brandColor)
        .setTitle(`📜 Container Logs: ${name} (Last ${lines} lines)`)
        .setDescription(`\`\`\`text\n${safeLogs}\n\`\`\``)
        .setFooter({ text: config.hostingName });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // =========================================================================
    // 7. SSH KEY
    // =========================================================================
    if (sub === 'sshkey') {
      const key = interaction.options.getString('key');
      try {
        container.addSshKey(name, key);
        return interaction.reply({
          content: `🔑 **SSH Public Key Added Successfully!** You can now connect via:\n\`ssh root@${container.getHostPublicIP()} -p ${vpsRecord.sshPort}\``,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to add SSH key: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // =========================================================================
    // 8. TERMINAL
    // =========================================================================
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

    // =========================================================================
    // 9. START, STOP, RESTART, DELETE
    // =========================================================================
    if (sub === 'start') {
      try {
        container.start(name);
        return interaction.reply({ content: `🟢 Started container \`${name}\`.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to start: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    if (sub === 'stop') {
      try {
        container.stop(name);
        return interaction.reply({ content: `🛑 Stopped container \`${name}\`.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to stop: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    if (sub === 'restart') {
      try {
        container.restart(name);
        return interaction.reply({ content: `🔄 Restarting container \`${name}\`...`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to restart: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    if (sub === 'delete') {
      try {
        container.delete(name);
        db.removeVPS(name);
        return interaction.reply({ content: `🗑️ Permanently deleted VPS \`${name}\`.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to delete: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // =========================================================================
    // 10. RENEW (Using Coins or Free Extension)
    // =========================================================================
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

    // =========================================================================
    // 11. REBUILD (Factory Reset)
    // =========================================================================
    if (sub === 'rebuild') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const targetOS = interaction.options.getString('os') || vpsRecord.image || config.defaultImage;

      try {
        const result = await container.rebuildContainer(name, targetOS, vpsRecord.template || 'none');
        db.setVPS(name, {
          ...vpsRecord,
          image: targetOS,
          sshPort: result.sshPort,
          webPort: result.webPort,
          webTerminalUrl: result.webTerminalUrl,
        });

        return interaction.editReply({
          content: `🔄 **VPS \`${name}\` has been rebuilt with a clean \`${targetOS}\` image!**\nNew Root Password: \`${result.password}\`\nSSH Port: \`${result.sshPort}\``,
        });
      } catch (err) {
        return interaction.editReply(`❌ Rebuild failed: ${err.message}`);
      }
    }

    // =========================================================================
    // 12. EXPOSE PORT (TCP / UDP)
    // =========================================================================
    if (sub === 'expose') {
      const targetPort = interaction.options.getInteger('port');
      const proto = interaction.options.getString('protocol') || 'tcp';

      if (targetPort < 1 || targetPort > 65535) {
        return interaction.reply({ content: '❌ Invalid port number (must be 1-65535).', flags: MessageFlags.Ephemeral });
      }

      try {
        const exposedResult = container.exposePort(name, targetPort, proto);
        const currentExposed = vpsRecord.exposedPorts || [];
        currentExposed.push(exposedResult);
        db.setVPS(name, { ...vpsRecord, exposedPorts: currentExposed });

        return interaction.reply({
          content: `🌐 **Port Forwarded Successfully!**\n\nContainer Port: \`${targetPort}\` (${proto.toUpperCase()})\nPublic Host Port: \`${exposedResult.hostPort}\`\nPublic Address: \`${exposedResult.publicUrl}\``,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        return interaction.reply({ content: `❌ Port forwarding failed: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // =========================================================================
    // 13. BACKUP & RESTORE
    // =========================================================================
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

    // =========================================================================
    // 14. UPGRADE PLAN
    // =========================================================================
    if (sub === 'upgrade') {
      const targetPlanKey = interaction.options.getString('plan');
      const targetPlan = config.plans[targetPlanKey];
      if (!targetPlan) {
        return interaction.reply({ content: '❌ Invalid plan selected.', flags: MessageFlags.Ephemeral });
      }

      const cost = targetPlanKey === 'bronze' ? config.costs.upgradeBronze : config.costs.upgradeSilver;
      const user = db.getUser(userId);

      if (!isAdmin && (user.coins || 0) < cost) {
        return interaction.reply({
          content: `❌ Insufficient coins! You need **${cost} coins** (You have: **${user.coins || 0} coins**). Use \`/vps daily\` to earn more!`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!isAdmin) {
        db.addCoins(userId, -cost);
      }

      db.setVPS(name, { ...vpsRecord, plan: targetPlanKey });
      return interaction.reply({
        content: `🎉 **Upgraded \`${name}\` to ${targetPlan.name}!** (${targetPlan.cpu} vCPU, ${targetPlan.ram} RAM).`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
