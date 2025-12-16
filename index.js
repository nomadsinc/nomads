// ========================
// IMPORTS
// ========================
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

const INVITE_TARGET_CHANNEL_ID = process.env.INVITE_TARGET_CHANNEL_ID; // where client lands when joining
const INVITE_REQUEST_CHANNEL_ID = process.env.INVITE_REQUEST_CHANNEL_ID; // where staff clicks button / uses /newclient

// ✅ replaced START_HERE_CHANNEL_ID with CURRICULUM_CHANNEL_ID
const CURRICULUM_CHANNEL_ID = process.env.CURRICULUM_CHANNEL_ID || null;

const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL || null;

// Optional: secure endpoint for Zapier to post the button message daily
const ZAPIER_POST_SECRET = process.env.ZAPIER_POST_SECRET || null;

// Staff roles: supports ONE or MANY (comma-separated)
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Team mentions
const FOUNDER_USER_ID = process.env.FOUNDER_USER_ID || null; // single user id
const CSM_USER_IDS = (process.env.CSM_USER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const OPERATIONS_USER_ID = process.env.OPERATIONS_USER_ID || null; // single user id

// Basic checks
if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!GUILD_ID) throw new Error("Missing GUILD_ID");
if (!INVITE_TARGET_CHANNEL_ID) throw new Error("Missing INVITE_TARGET_CHANNEL_ID");
if (!INVITE_REQUEST_CHANNEL_ID) throw new Error("Missing INVITE_REQUEST_CHANNEL_ID");

// ========================
// EXPRESS SERVER (health + optional zapier endpoints)
// ========================
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send(`${BUSINESS_NAME} bot running`));

// ========================
// DISCORD BOT SETUP
// ========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged (must be enabled in Dev Portal)
    GatewayIntentBits.GuildInvites
  ]
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
  return slugify(BUSINESS_NAME) || "business";
}
function isStaff(member) {
  // If no staff roles set, allow anyone (not recommended)
  if (!STAFF_ROLE_IDS.length) return true;
  return STAFF_ROLE_IDS.some(rid => member.roles.cache.has(rid));
}

// Button message content + components
function buildInviteButtonMessage() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("gen_invite_btn")
      .setLabel("Generate New Client Invite")
      .setStyle(ButtonStyle.Primary)
  );

  return {
    content: "Click to generate a 1-use invite for a new client (firstname mapping included).",
    components: [row]
  };
}

// ========================
// OPTIONAL: ZAPIER → POST BUTTON MESSAGE (SECURED)
// ========================
app.post("/post-invite-button", async (req, res) => {
  try {
    const incoming = req.header("x-zapier-secret");
    if (!ZAPIER_POST_SECRET || incoming !== ZAPIER_POST_SECRET) {
      return res.status(401).send("Unauthorized");
    }

    if (!client.isReady()) {
      return res.status(503).send("Discord client not ready yet");
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const requestChannel = await guild.channels.fetch(INVITE_REQUEST_CHANNEL_ID);

    if (!requestChannel || !requestChannel.isTextBased()) {
      return res.status(400).send("Invite request channel not found or not text-based.");
    }

    await requestChannel.send(buildInviteButtonMessage());
    return res.send("ok");
  } catch (err) {
    console.error("post-invite-button error:", err);
    return res.status(500).send("error");
  }
});

app.listen(process.env.PORT || 3000, () => console.log("HTTP server listening"));

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
          .setDescription("Client firstname (used for category/channel)")
          .setRequired(true)
      )
      .toJSON()
  ];

  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log("✅ Slash command registered: /newclient");
}

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
// READY
// ========================
client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Cache invites (if perms missing, don’t break bot)
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const invites = await guild.invites.fetch();
    invites.forEach(inv => inviteUses.set(inv.code, inv.uses));
    console.log("Cached existing invites.");
  } catch (err) {
    console.error("Error caching invites:", err);
  }

  // Register slash command
  try {
    await registerCommands();
  } catch (err) {
    console.error("Error registering commands:", err);
  }

  // Post the button message in the request channel (on boot)
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const requestChannel = await guild.channels.fetch(INVITE_REQUEST_CHANNEL_ID);
    if (requestChannel && requestChannel.isTextBased()) {
      await requestChannel.send(buildInviteButtonMessage());
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

    // Slash command
    if (interaction.isChatInputCommand() && interaction.commandName === "newclient") {
      try {
        const firstname = interaction.options.getString("firstname", true).trim();
        const inviteUrl = await createMappedInvite(firstname);
        return interaction.reply({
          content: `✅ Invite for **${firstname}**:\n${inviteUrl}`,
          ephemeral: true
        });
      } catch (err) {
        console.error("/newclient failed:", err);
        return interaction.reply({
          content: "❌ Failed to create invite. Check bot permissions (Create Invite + channel access).",
          ephemeral: true
        });
      }
    }

    // ✅ HARDENED BUTTON HANDLER (won’t show “interaction failed”)
    if (interaction.isButton() && interaction.customId === "gen_invite_btn") {
      try {
        const modal = new ModalBuilder()
          .setCustomId("gen_invite_modal")
          .setTitle("New Client Invite");

        const input = new TextInputBuilder()
          .setCustomId("firstname_input")
          .setLabel("Client firstname")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));

        return await interaction.showModal(modal);
      } catch (err) {
        console.error("Button click -> showModal failed:", err);
        try {
          return await interaction.reply({
            content: "⚠️ Button had an issue. Use `/newclient firstname:John` instead.",
            ephemeral: true
          });
        } catch {
          try {
            return await interaction.followUp({
              content: "⚠️ Button had an issue. Use `/newclient firstname:John` instead.",
              ephemeral: true
            });
          } catch {}
        }
      }
    }

    // ✅ HARDENED MODAL SUBMIT
    if (interaction.isModalSubmit() && interaction.customId === "gen_invite_modal") {
      try {
        const firstname = interaction.fields.getTextInputValue("firstname_input").trim();
        const inviteUrl = await createMappedInvite(firstname);

        return await interaction.reply({
          content: `✅ Invite for **${firstname}**:\n${inviteUrl}`,
          ephemeral: true
        });
      } catch (err) {
        console.error("Modal submit failed:", err);
        return await interaction.reply({
          content: "❌ Couldn’t create invite. Check permissions and try again.",
          ephemeral: true
        });
      }
    }
  } catch (err) {
    console.error("interactionCreate error:", err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Something went wrong.", ephemeral: true });
      }
    } catch {}
  }
});

// ========================
// ON JOIN: create category/channels + onboarding message
// ========================
client.on("guildMemberAdd", async (member) => {
  try {
    const guild = member.guild;

    // Fetch invites to detect which code was used
    let usedInvite = null;
    try {
      const newInvites = await guild.invites.fetch();
      newInvites.forEach(inv => {
        const prev = inviteUses.get(inv.code) || 0;
        if (inv.uses > prev) usedInvite = inv;
        inviteUses.set(inv.code, inv.uses);
      });
    } catch (err) {
      console.error("Invite fetch failed on join (permissions?):", err);
    }

    let firstname = "Client";
    if (usedInvite) {
      firstname =
        inviteMap.get(usedInvite.code) ||
        member.displayName ||
        member.user.username ||
        "Client";
      console.log(`Join matched invite ${usedInvite.code} → firstname: ${firstname}`);
    } else {
      firstname = member.displayName || member.user.username || "Client";
      console.log(`⚠ No invite match. Using fallback firstname: ${firstname}`);
    }

    firstname = firstname.trim();
    const categoryName = `${firstname} - ${BUSINESS_NAME}`;
    console.log(`Creating channels for: ${firstname}`);

    // ========================
    // CREATE CATEGORY
    // ========================
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

    for (const rid of STAFF_ROLE_IDS) {
      overwrites.push({
        id: rid,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
      });
    }

    await category.permissionOverwrites.set(overwrites);

    // ========================
    // CREATE CHANNELS (1 personalised channel)
    // ========================
    const teamChatChannelName = `🤝│${businessSlug()}-${slugify(firstname)}`;
    const teamChatChannel = await guild.channels.create({
      name: teamChatChannelName,
      type: ChannelType.GuildText,
      parent: category.id
    });

    // ========================
    // SEND ONBOARDING MESSAGE (UPDATED + curriculum mention)
    // ========================
    const newMemberMention = `<@${member.id}>`;
    const founder = mentionUser(FOUNDER_USER_ID, "Founder");
    const csms = mentionUsers(CSM_USER_IDS, "Client Success Managers");
    const ops = mentionUser(OPERATIONS_USER_ID, "Operations Manager");
    const curriculum = mentionChannel(CURRICULUM_CHANNEL_ID, "#curriculum");

    const msg = `
**Welcome to ${BUSINESS_NAME}!**

Hey ${newMemberMention}, we’re excited to have you here and officially get started together.

By joining ${BUSINESS_NAME}, you’re partnering with a hands-on growth team focused on helping you scale your agency, coaching, or consulting business in a clear and repeatable way. Our goal is to remove confusion, handle execution, and give you a simple path to growth.

From here on out, we’ll work with you to refine your offer, build and launch ads and funnels, set up the right automations, and optimize everything based on real data. You’re not just hiring a service — you’re gaining a long-term growth partner.

- - - - -

**I’d Like to Introduce You to Your Team…**

${founder} – **Founder & Strategy Lead**  
Oversees your growth strategy, offer positioning, and overall direction to ensure everything is built to scale.

${csms} – **Client Success Managers**  
Your main point of contact. They’re here to answer questions, provide clarity, guide next steps, and keep you moving forward smoothly.

${ops} – **Operations Manager**  
Ensures onboarding, timelines, and internal coordination run seamlessly so nothing falls through the cracks.

Handles ad creation, funnel builds, automations, tracking, and ongoing optimization behind the scenes.

- - - - -

**How We’ll Work Together**

This Discord is your direct line to the team. Ask questions anytime, share updates, and reach out whenever you need clarity — we’re here to support you at every step.

- - - - -

**Next Steps (Please Complete in Order)**

1. Invite any team members you’d like included in this workspace.  
2. Join the Circle Group in ${curriculum} and watch all Pre-Onboarding videos.  
3. Read your On-Boarding Email carefully — it outlines key expectations and what happens next.

Once these are complete, we’ll take it from there and guide you through the rest.

We’re excited to grow with you. Welcome aboard!
    `.trim();

    await teamChatChannel.send(msg);

    // Optional: notify Zapier on join
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
