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

// Fetch real-time invite uses for a user
async function fetchUserInvites(guild, userId) {
  try {
    if (!guild) return 0;
    const invites = await guild.invites.fetch();
    const userInvites = invites.filter((inv) => inv.inviter && inv.inviter.id === userId);
    return userInvites.reduce((acc, inv) => acc + (inv.uses || 0), 0);
  } catch (err) {
    console.warn('[Invite Fetch Warning]:', err.message);
    return 0;
  }
}

// Calculate active booster tier and resource specs
function calculateBoostTier(invitesCount) {
  let activeTier = null;
  let nextTier = null;

  for (const tier of config.inviteBoosters) {
    if (invitesCount >= tier.minInvites) {
      activeTier = tier;
    } else if (!nextTier) {
      nextTier = tier;
    }
  }

  const baseRam = 32;
  const baseCpu = 1;
  const baseDisk = 16;

  if (!activeTier) {
    return {
      tierName: 'Base Free Starter',
      ram: '32GiB',
      cpu: '1',
      disk: '16GiB',
      ramNum: 32,
      cpuNum: 1,
      diskNum: 16,
      activeTier: null,
      nextTier: config.inviteBoosters[0],
    };
  }

  const totalRam = baseRam + activeTier.ramBoostGiB;
  const totalCpu = baseCpu + activeTier.cpuBoost;
  const totalDisk = baseDisk + activeTier.diskBoostGiB;

  return {
    tierName: activeTier.name,
    ram: `${totalRam}GiB`,
    cpu: `${totalCpu}`,
    disk: `${totalDisk}GiB`,
    ramNum: totalRam,
    cpuNum: totalCpu,
    diskNum: totalDisk,
    activeTier,
    nextTier,
  };
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
  fetchUserInvites,
  calculateBoostTier,
  data: new SlashCommandBuilder()
    .setName('vps')
    .setDescription('Complete Virtual Private Server (VPS) Management')
    // 1. CREATE (Free Starter 32GB RAM / 1 Core / 16GB Disk for Everyone)
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create your 32GB RAM Free Starter VPS container')
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
    // 2. BOOST / INVITES (Invite Booster System)
    .addSubcommand((sub) =>
      sub
        .setName('boost')
        .setDescription('Check your server invites and upgrade your VPS with extra RAM, Cores & Disk')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name to upgrade').setRequired(false))
    )
    // 3. LIST
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List all your active VPS instances')
    )
    // 4. INFO
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription('Show detailed information, control panel, and live stats of your VPS')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    // 5. STATS
    .addSubcommand((sub) =>
      sub
        .setName('stats')
        .setDescription('View real-time CPU, RAM, Disk, and Network I/O metrics')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    // 6. TERMINAL
    .addSubcommand((sub) =>
      sub
        .setName('terminal')
        .setDescription('Get a secure web browser terminal link for your VPS')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    // 7. EXEC
    .addSubcommand((sub) =>
      sub
        .setName('exec')
        .setDescription('Execute a quick bash command inside your container')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addStringOption((opt) => opt.setName('command').setDescription('Bash command to execute').setRequired(true))
    )
    // 8. LOGS
    .addSubcommand((sub) =>
      sub
        .setName('logs')
        .setDescription('View the latest system / console output logs')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addIntegerOption((opt) => opt.setName('lines').setDescription('Number of lines (default: 30)').setRequired(false))
    )
    // 9. SSH KEY
    .addSubcommand((sub) =>
      sub
        .setName('sshkey')
        .setDescription('Add your SSH public key for passwordless terminal login')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addStringOption((opt) => opt.setName('key').setDescription('Your public key (ssh-rsa / ssh-ed25519)').setRequired(true))
    )
    // 10. START, STOP, RESTART, DELETE
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
    // 11. RENEW
    .addSubcommand((sub) =>
      sub.setName('renew').setDescription('Renew / extend your VPS expiration date')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    // 12. REBUILD
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
    // 13. EXPOSE PORT
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
    // 14. BACKUP & RESTORE
    .addSubcommand((sub) =>
      sub.setName('backup').setDescription('Create an instant snapshot backup of your VPS')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub.setName('restore').setDescription('Restore your VPS from a previous snapshot backup')
        .addStringOption((opt) => opt.setName('name').setDescription('Container name').setRequired(true))
        .addStringOption((opt) => opt.setName('tag').setDescription('Backup tag to restore').setRequired(true))
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
      const invitesCount = await fetchUserInvites(interaction.guild, userId);
      const boostInfo = calculateBoostTier(invitesCount);

      const embed = new EmbedBuilder()
        .setColor('#FFAA00')
        .setTitle(`💰 Economy & Invites Profile: ${interaction.user.username}`)
        .addFields(
          { name: '🪙 Coin Balance', value: `**${user.coins || 0} Coins**`, inline: true },
          { name: '💌 Valid Server Invites', value: `**${invitesCount} Invites**`, inline: true },
          { name: '⚡ Active Boost Tier', value: `**${boostInfo.tierName}**`, inline: true },
          { name: '🖥️ Active VPS Containers', value: `**${userVPS.length} Containers**`, inline: true },
          { name: '🎁 Daily Reward', value: '`/vps daily` (+50 Coins)', inline: true },
          {
            name: '📈 Invite Extension Tiers',
            value:
              `• **2 Invites:** +5GB RAM, +1 Core, +5GB Disk ➔ **37GB RAM / 2 Cores**\n` +
              `• **12 Invites:** +40GB RAM, +2 Cores, +20GB Disk ➔ **72GB RAM / 3 Cores**\n` +
              `• **20 Invites:** +50GB RAM, +4 Cores, +32GB Disk ➔ **82GB RAM / 5 Cores**\n` +
              `• **30 Invites:** +64GB RAM, +12 Cores, +40GB Disk ➔ **96GB RAM / 13 Cores**`,
            inline: false,
          }
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
    // 2. BOOST / INVITES
    // =========================================================================
    if (sub === 'boost') {
      if (!interaction.deferred && !interaction.replied) {
        try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch {}
      }
      const invitesCount = await fetchUserInvites(interaction.guild, userId);
      const boostInfo = calculateBoostTier(invitesCount);
      const userVPS = db.getUserVPSList(userId);

      const targetVpsName = interaction.options.getString('name') || (userVPS.length > 0 ? userVPS[0].containerName : null);
      const vpsRecord = targetVpsName ? db.getVPS(targetVpsName) : null;

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`⚡ Server Invite Booster System`)
        .setDescription(
          `Invite your friends to the server to unlock massive resource upgrades for your VPS!\n\n` +
          `📊 **Your Current Invites:** **${invitesCount} Valid Joins**\n` +
          `🌟 **Unlocked Resource Tier:** **${boostInfo.tierName}**\n` +
          `⚡ **Eligible Specs:** **${boostInfo.ram} RAM • ${boostInfo.cpu} vCPU • ${boostInfo.disk} Disk**`
        )
        .addFields(
          {
            name: '📋 Invite Milestone Ladder',
            value:
              `• **2 Invites:** \`+5GB RAM\` • \`+1 Core\` • \`+5GB Disk\` ➔ **37GB RAM / 2 Cores**\n` +
              `• **12 Invites:** \`+40GB RAM\` • \`+2 Cores\` • \`+20GB Disk\` ➔ **72GB RAM / 3 Cores**\n` +
              `• **20 Invites:** \`+50GB RAM\` • \`+4 Cores\` • \`+32GB Disk\` ➔ **82GB RAM / 5 Cores**\n` +
              `• **30 Invites:** \`+64GB RAM\` • \`+12 Cores\` • \`+40GB Disk\` ➔ **96GB RAM / 13 Cores**`,
            inline: false,
          }
        )
        .setFooter({ text: `${config.hostingName} • Dynamic Container Upgrades` });

      if (boostInfo.nextTier) {
        const remaining = boostInfo.nextTier.minInvites - invitesCount;
        embed.addFields({
          name: '🎯 Next Tier Goal',
          value: `Invite **${remaining} more friend${remaining > 1 ? 's' : ''}** to unlock **${boostInfo.nextTier.name}**!`,
          inline: false,
        });
      }

      const components = [];
      if (vpsRecord) {
        components.push(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`vps_btn_applyboost_${vpsRecord.containerName}`)
              .setLabel(`⚡ Apply Boost to ${vpsRecord.containerName}`)
              .setStyle(ButtonStyle.Success)
          )
        );
      }

      return interaction.editReply({ embeds: [embed], components });
    }

    // =========================================================================
    // 1. CREATE (Free Starter 32GB RAM / 1 Core / 16GB Disk)
    // =========================================================================
    if (sub === 'create') {
      if (!interaction.deferred && !interaction.replied) {
        try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch {}
      }

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

      // Automatically compute any initial boost from invites
      const invitesCount = await fetchUserInvites(interaction.guild, userId);
      const boostInfo = calculateBoostTier(invitesCount);
      const plan = config.plans.free;

      const osImage = interaction.options.getString('os') || config.defaultImage;
      const templateKey = interaction.options.getString('template') || 'none';
      const templateInfo = config.templates[templateKey] || config.templates.none;

      const progressEmbed = new EmbedBuilder()
        .setColor(config.brandColor)
        .setTitle(`🚀 Provisioning ${safeName}...`)
        .setDescription(
          `Creating your **${plan.name}** container using image \`${osImage}\`.\n` +
          `⚡ **Allocated Specs:** **${boostInfo.ram} RAM • ${boostInfo.cpu} vCPU • ${boostInfo.disk} Disk**\n` +
          `📦 **Template:** ${templateInfo.name}\n\n` +
          `*Allocating resources, hardening security sandbox, and initializing PTY terminal...*`
        )
        .setFooter({ text: config.hostingName });

      await interaction.editReply({ embeds: [progressEmbed] });

      try {
        const result = await container.createContainer({
          name: safeName,
          image: osImage,
          cpu: boostInfo.cpu,
          ram: boostInfo.ram,
          disk: boostInfo.disk,
          templateKey,
        });

        db.setVPS(safeName, {
          containerName: safeName,
          ownerId: userId,
          ownerTag: interaction.user.tag,
          plan: 'free',
          ram: boostInfo.ram,
          cpu: boostInfo.cpu,
          disk: boostInfo.disk,
          boostTier: boostInfo.tierName,
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
            { name: '⚡ Resources', value: `**${boostInfo.ram} RAM • ${boostInfo.cpu} vCPU**`, inline: true },
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
    // 3. LIST
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
          value: `**Specs:** ${v.ram || '32GiB'} RAM / ${v.cpu || '1'} vCPU\n**Status:** ${status}\n**Expires:** ${expireStr}\n**SSH Port:** \`${v.sshPort || '22'}\``,
          inline: true,
        });
      });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // Container-level operations: Check ownership / admin privileges
    const name = interaction.options.getString('name');
    const vpsRecord = name ? db.getVPS(name) : null;

    if (name && !vpsRecord) {
      return interaction.reply({ content: `❌ VPS \`${name}\` not found in database.`, flags: MessageFlags.Ephemeral });
    }

    if (vpsRecord && vpsRecord.ownerId !== userId && !isAdmin) {
      return interaction.reply({ content: `❌ You do not own this VPS.`, flags: MessageFlags.Ephemeral });
    }

    // =========================================================================
    // 4. INFO & CONTROL PANEL
    // =========================================================================
    if (sub === 'info') {
      const live = container.getInfo(name);
      const isRunning = live?.status === 'Running';
      const expireStr = vpsRecord.expiresAt ? new Date(vpsRecord.expiresAt).toLocaleString() : 'Permanent';
      const templateInfo = config.templates[vpsRecord.template] || { name: 'Standard' };
      const exposed = (vpsRecord.exposedPorts || []).map((p) => `• Port \`${p.containerPort}\` (${p.protocol}) ➔ \`${p.publicUrl}\``).join('\n') || 'None';
      const backups = (vpsRecord.backups || []).map((b) => `• \`${b.tag}\` (${new Date(b.timestamp).toLocaleDateString()})`).join('\n') || 'None';

      const embed = new EmbedBuilder()
        .setColor(isRunning ? '#00FF88' : '#FF4444')
        .setTitle(`📊 VPS Control Panel: ${name}`)
        .setDescription(`Use the interactive buttons below to manage your container power and snapshots in real time.`)
        .addFields(
          { name: 'Status', value: isRunning ? '🟢 Running' : '🔴 Stopped', inline: true },
          { name: 'Allocated Specs', value: `**${vpsRecord.ram || '32GiB'} RAM • ${vpsRecord.cpu || '1'} vCPU**`, inline: true },
          { name: 'Booster Tier', value: `${vpsRecord.boostTier || 'Base Free Starter'}`, inline: true },
          { name: 'Template', value: `${templateInfo.name}`, inline: true },
          { name: 'Internal IP', value: `\`${live?.ipv4 || 'None'}\``, inline: true },
          { name: 'SSH Port', value: `\`${vpsRecord.sshPort || live?.sshPort || '22'}\``, inline: true },
          { name: 'Memory', value: `\`${live?.memoryUsage || '0 MB'}\``, inline: true },
          { name: 'Owner', value: `<@${vpsRecord.ownerId}>`, inline: true },
          { name: 'Expires', value: `${expireStr}`, inline: true },
          { name: 'OS Image', value: `\`${vpsRecord.image || 'ubuntu'}\``, inline: true },
          { name: '💻 Direct SSH Login', value: `\`ssh root@${container.getHostPublicIP()} -p ${vpsRecord.sshPort || '22'}\``, inline: false },
          { name: '🌐 Forwarded Ports', value: exposed, inline: false },
          { name: '📸 Snapshots & Backups', value: backups, inline: false }
        )
        .setFooter({ text: `${config.hostingName} • Interactive Control Panel` });

      const components = [buildControlButtons(name, isRunning)];
      const actionRow2 = new ActionRowBuilder();

      if (vpsRecord.webTerminalUrl) {
        actionRow2.addComponents(
          new ButtonBuilder().setLabel('🚀 Open Web Terminal').setURL(vpsRecord.webTerminalUrl).setStyle(ButtonStyle.Link)
        );
      }
      actionRow2.addComponents(
        new ButtonBuilder().setCustomId(`vps_btn_applyboost_${name}`).setLabel('⚡ Claim Invite Boost').setStyle(ButtonStyle.Success)
      );
      components.push(actionRow2);

      return interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
    }

    // =========================================================================
    // 5. STATS (Live ASCII Progress Bars)
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
    // 6. EXEC (Quick Remote Runner)
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
    // 7. LOGS
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
    // 8. SSH KEY
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
    // 9. TERMINAL & SSH LOGIN
    // =========================================================================
    if (sub === 'terminal') {
      const hostIp = container.getHostPublicIP();
      const sshPort = vpsRecord.sshPort || '22';
      const sshCmd = `ssh root@${hostIp} -p ${sshPort}`;

      let webLink = vpsRecord.webTerminalUrl || null;
      try {
        webLink = await container.createWebTerminal(name);
      } catch {}

      const embed = new EmbedBuilder()
        .setColor('#00FF88')
        .setTitle(`💻 Terminal & SSH Login: ${name}`)
        .setDescription(
          `Connect directly to your container using any standard SSH client or terminal.\n\n` +
          `### ⚡ Direct SSH Connection (Recommended)\n` +
          `Copy and paste this command into **PowerShell, Terminal, Command Prompt, or Termius**:\n` +
          `\`\`\`bash\n${sshCmd}\n\`\`\`\n` +
          `🔑 **Username:** \`root\`\n` +
          `🔒 **Password:** \`${vpsRecord.password || '(Use your container root password)'}\`\n` +
          `🔌 **Port:** \`${sshPort}\`\n` +
          (webLink ? `\n🌐 **Web Terminal Link:** [Click here to open](${webLink})\n` : '')
        )
        .setFooter({ text: `${config.hostingName} • Direct SSH Shell` });

      const components = [];
      if (webLink) {
        components.push(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🚀 Launch Web Terminal').setURL(webLink).setStyle(ButtonStyle.Link)
          )
        );
      }

      let dmSent = false;
      try {
        await interaction.user.send({ embeds: [embed], components });
        dmSent = true;
      } catch (e) {
        console.warn('Could not send DM to user:', e.message);
      }

      if (dmSent) {
        return interaction.reply({
          content: `📩 **SSH login command and credentials for \`${name}\` have been sent privately to your DMs.**`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        return interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
      }
    }

    // =========================================================================
    // 10. START, STOP, RESTART, DELETE
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
    // 11. RENEW
    // =========================================================================
    if (sub === 'renew') {
      const plan = config.plans.free;
      const durationMs = (plan.durationDays || 30) * 24 * 60 * 60 * 1000;
      const currentExpiry = vpsRecord.expiresAt && vpsRecord.expiresAt > Date.now() ? vpsRecord.expiresAt : Date.now();
      const newExpiry = currentExpiry + durationMs;

      db.setVPS(name, { ...vpsRecord, expiresAt: newExpiry });
      return interaction.reply({
        content: `✅ VPS \`${name}\` renewed successfully! New expiration date: **${new Date(newExpiry).toLocaleDateString()}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // =========================================================================
    // 12. REBUILD
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
    // 13. EXPOSE PORT
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
    // 14. BACKUP & RESTORE
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
  },
};
