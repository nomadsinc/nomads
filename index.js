const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  Routes
} = require("discord.js");
const { REST } = require("@discordjs/rest");
const express = require("express");

// ========================
// ENV (matches your Render keys)
// ========================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Your Business";
const GUILD_ID = process.env.GUILD_ID;

const INVITE_TARGET_CHANNEL_ID = process.env.INVITE_TARGET_CHANNEL_ID;
const INVITE_REQUEST_CHANNEL_ID = process.env.INVITE_REQUEST_CHANNEL_ID;
const START_HERE_CHANNEL_ID = process.env.START_HERE_CHANNEL_ID || null;

const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL || null;

// Staff roles: supports ONE or MANY (comma-separated)
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Team mentions (matches your keys)
const FOUNDER_USER_ID = process.env.FOUNDER_USER_ID || null; // single
const CSM_USER_IDS = (process.env.CSM_USER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const OPERATIONS_USER_ID = process.env.OPERATIONS_USER_ID || null; // single

// Basic checks
if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!GUILD_ID) throw new Error("Missing GUILD_ID");
if (!INVITE_TARGET_CHANNEL_ID) throw new Error("Missing INVITE_TARGET_CHANNEL_ID");
if (!INVITE_REQUEST_CHANNEL_ID) throw new Error("Missing INVITE_REQUEST_CHANNEL_ID");

// ========================
// EXPRESS (health check)
// ========================
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send(`${BUSINESS_NAME} bot running`));
app.listen(process.env.PORT || 3000, () => console.log("HTTP server listening"));

// ========================
// BOT
// ========================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites]
});

// inviteCode -> firstname (in-memory)
const inviteMap = new Map();
// invite usage cache
const inviteUses = new Map();

// ========================
// HELPERS
// ========================
function mentionUser(userId, fallbackText) {
  if (!userId) return fallbackText;
  return `<@${userId}>`;
}
function mentionUsers(userIds, fallbackText) {
  if (!userIds || userIds.length === 0) return fallbackText;
  return userIds.map(id => `<@${id}>`).join(" & ");
}
function mentionChannel(channelId, fallbackText) {
  if (!channelId) return fallbackText;
  return `<#${channelId}>`;
}
function slugify(input) {
  return (input || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .slice(0, 40);
}
function businessSlug() {
  // "Nomads" -> "nomads"
  return slugify(BUSINESS_NAME) || "business";
}
function isStaff(member) {
  // If no staff roles set, allow anyone (not recommended)
  if (!STAFF_ROLE_IDS.length) return true;
  return STAFF_ROLE_IDS.some(rid => member.roles.cache.has(rid));
}

// ========================
// REGISTER SLASH COMMAND
// ========================
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  const commands = [
    new SlashCommandBuilder()
      .setName("newclient")
      .setDescription("Generate a 1-use invite for a new client and map it to their firstname.")
      .addStringOption(opt =>
        opt
          .setName("firstname")
          .setDescription("Client firstname (used for category/channels)")
          .setRequired(true)
      )
      .toJSON()
  ];

  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log("✅ Slash command registered: /newclient");
}

// ========================
// READY
// ========================
client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);

  // Cache invites (needs Manage Server / Manage Guild OR specific invite perms)
  try {
    const invites = await guild.invites.fetch();
    invites.forEach(inv => inviteUses.set(inv.code, inv.uses));
    console.log("Cached existing invites.");
  } catch (err) {
    console.error("Error caching invites:", err);
  }

  // Register slash command
  await registerCommands();

  // Post the button in the request channel
  try {
    const requestChannel = await guild.channels.fetch(INVITE_REQUEST_CHANNEL_ID);
    if (requestChannel && requestChannel.isTextBased()) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("gen_invite_btn")
          .setLabel("Generate New Client Invite")
          .setStyle(ButtonStyle.Primary)
      );

      await requestChannel.send({
        content: "Click to generate a 1-use invite for a new client (firstname mapping included).",
        components: [row]
      });
    }
  } catch (err) {
    console.error("Error posting invite button:", err);
  }
});

// ========================
// INTERACTIONS (slash + button + modal)
// ========================
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: "Use this inside the server.", ephemeral: true });
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(interaction.user.id);

    if (!isStaff(member)) {
      return interaction.reply({ content: "You don’t have permission to do that.", ephemeral: true });
    }

    // Slash command: /newclient firstname:...
    if (interaction.isChatInputCommand() && interaction.commandName === "newclient") {
      const firstname = interaction.options.getString("firstname", true).trim();
      const inviteUrl = await createMappedInvite(firstname);
      return interaction.reply({ content: `✅ Invite for **${firstname}**:\n${inviteUrl}`, ephemeral: true });
    }

    // Button: open modal
    if (interaction.isButton() && interaction.customId === "gen_invite_btn") {
      const modal = new ModalBuilder()
        .setCustomId("gen_invite_modal")
        .setTitle("New Client Invite");

      const input = new TextInputBuilder()
        .setCustomId("firstname_input")
        .setLabel("Client firstname")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // Modal submit: generate invite
    if (interaction.isModalSubmit() && interaction.customId === "gen_invite_modal") {
      const firstname = interaction.fields.getTextInputValue("firstname_input").trim();
      const inviteUrl = await createMappedInvite(firstname);
      return interaction.reply({ content: `✅ Invite for **${firstname}**:\n${inviteUrl}`, ephemeral: true });
    }
  } catch (err) {
    console.error("interactionCreate error:", err);
    try {
      if (!interaction.replied) {
        await interaction.reply({ content: "Something went wrong.", ephemeral: true });
      }
    } catch {}
  }
});

// ========================
// CREATE INVITE + MAP firstname
// ========================
async function createMappedInvite(firstnameRaw) {
  const guild = await client.guilds.fetch(GUILD_ID);
  const inviteChannel = await guild.channels.fetch(INVITE_TARGET_CHANNEL_ID);

  if (!inviteChannel || !inviteChannel.isTextBased()) {
    throw new Error("Invite target channel not found or not text-based.");
  }

  const firstname = firstnameRaw.trim();

  // Create 1-use invite
  const invite = await inviteChannel.createInvite({
    maxUses: 1,
    maxAge: 0,
    unique: true
  });

  inviteMap.set(invite.code, firstname);
  console.log(`Mapped (internal) ${invite.code} → ${firstname}`);

  return `https://discord.gg/${invite.code}`;
}

// ========================
// ON JOIN: create category/channels + onboarding message
// ========================
client.on("guildMemberAdd", async (member) => {
  try {
    const guild = member.guild;

    const newInvites = await guild.invites.fetch();
    let usedInvite = null;

    newInvites.forEach(inv => {
      const prev = inviteUses.get(inv.code) || 0;
      if (inv.uses > prev) usedInvite = inv;
      inviteUses.set(inv.code, inv.uses);
    });

    let firstname = "Client";
    if (usedInvite) {
      firstname =
        inviteMap.get(usedInvite.code) ||
        member.displayName ||
        member.user.username ||
        "Client";
      console.log(`Join matched invite ${usedInvite.code} → firstname: ${firstname}`);
    } else {
      console.log(`⚠ No invite match for ${member.user.tag}, fallback name used.`);
      firstname = member.displayName || member.user.username || "Client";
    }

    firstname = firstname.trim();

    // CATEGORY_FORMAT: Firstname - Business
    const categoryName = `${firstname} - ${BUSINESS_NAME}`;

    // Create category
    const category = await guild.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory
    });

    // Permission overwrites
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
    ];

    // allow staff roles (supports many)
    for (const rid of STAFF_ROLE_IDS) {
      overwrites.push({
        id: rid,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
      });
    }

    await category.permissionOverwrites.set(overwrites);

    // Create the personalised channel: 🤝│nomads-name -> 🤝│nomads-firstname
    const channelName = `🤝│${businessSlug()}-${slugify(firstname)}`;
    const teamChatChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id
    });

    // Welcome message (simple + tags)
    const newMemberMention = `<@${member.id}>`;
    const founder = mentionUser(FOUNDER_USER_ID, "Founder");
    const csms = mentionUsers(CSM_USER_IDS, "Client Success");
    const ops = mentionUser(OPERATIONS_USER_ID, "Operations");
    const startHere = mentionChannel(START_HERE_CHANNEL_ID, "#start-here");

    const msg = `
✨ **Welcome to ${BUSINESS_NAME}!**

Hey ${newMemberMention}, we’re genuinely excited to have you here.

👥 **Meet Your Team**
${founder} – **Founder**  
${csms} – **Client Success Managers**  
${ops} – **Operations Manager**

**Next step:** Head over to ${startHere} and complete your intake form.
    `.trim();

    await teamChatChannel.send(msg);

    // Optional: notify Zapier webhook
    if (ZAPIER_WEBHOOK_URL) {
      try {
        const payload = {
          firstname,
          businessName: BUSINESS_NAME,
          discordId: member.id,
          discordTag: `${member.user.username}#${member.user.discriminator}`,
          categoryName,
          joinedAt: new Date().toISOString()
        };

        await fetch(ZAPIER_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        console.log("Notified Zapier about new member join.");
      } catch (err) {
        console.error("Error notifying Zapier:", err);
      }
    }

    console.log(`✅ Created category + channel for ${firstname}`);
  } catch (err) {
    console.error("guildMemberAdd error:", err);
  }
});

// ========================
// LOGIN
// ========================
client.login(DISCORD_TOKEN);
