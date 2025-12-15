// ========================
// IMPORTS
// ========================
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits
} = require("discord.js");

const express = require("express");

// ========================
// CORE CONFIG (Nomads)
// ========================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // required
const BUSINESS_NAME = "Nomads";

const GUILD_ID = "1440504953335578746";
const INVITE_TARGET_CHANNEL_ID = "1442209053374808157";
const START_HERE_CHANNEL_ID = "1442229060922114178";

// Optional staff role that can see all client categories
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null;

// Team members (specific people)
const FOUNDER_USER_IDS = ["1442209530015387759"];
const CSM_USER_IDS = ["1442210243097399386"];
const OPERATIONS_USER_ID = "1450124907269722124";

// Optional (not provided)
const FULFILMENT_USER_ID = null;

// Email on join disabled for this build
const ZAPIER_WEBHOOK_URL = null;

// ========================
// EXPRESS SERVER (INVITE MAP)
// ========================
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// inviteCode → firstname
const inviteMap = new Map();

app.get("/", (req, res) => {
  res.send(`${BUSINESS_NAME} Discord Bot is running.`);
});

// Zapier posts inviteCode + firstname here
app.post("/invite-map", (req, res) => {
  const { inviteCode, firstname } = req.body;

  if (!inviteCode || !firstname) {
    return res.status(400).send("inviteCode and firstname required");
  }

  inviteMap.set(inviteCode, firstname.trim());
  console.log(`Mapped ${inviteCode} → ${firstname.trim()}`);

  return res.send("ok");
});

app.listen(PORT, () => {
  console.log("HTTP server listening on port " + PORT);
});

// ========================
// DISCORD BOT SETUP
// ========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ]
});

const inviteUses = new Map();

// ========================
// HELPERS
// ========================
function mentionUsers(userIds, fallbackText) {
  if (!userIds || userIds.length === 0) return fallbackText;
  return userIds.map(id => `<@${id}>`).join(" & ");
}

function mentionUser(userId, fallbackText) {
  if (!userId) return fallbackText;
  return `<@${userId}>`;
}

function mentionChannel(channelId, fallbackText) {
  if (!channelId) return fallbackText;
  return `<#${channelId}>`;
}

function slugifyName(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .slice(0, 40); // keep channel names safe
}

// ========================
// READY EVENT
// ========================
client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const invites = await guild.invites.fetch();
    invites.forEach(inv => inviteUses.set(inv.code, inv.uses));
    console.log("Cached existing invites.");
  } catch (err) {
    console.error("Error caching invites:", err);
  }
});

// ========================
// MEMBER JOIN EVENT
// ========================
client.on("guildMemberAdd", async (member) => {
  try {
    const guild = member.guild;

    // Fetch invites (we’ll find the one that incremented)
    const newInvites = await guild.invites.fetch();

    let usedInvite = null;
    newInvites.forEach(inv => {
      const prev = inviteUses.get(inv.code) || 0;
      if (inv.uses > prev) usedInvite = inv;
      inviteUses.set(inv.code, inv.uses);
    });

    // Resolve firstname from invite map (Option A)
    let firstname;
    if (usedInvite) {
      firstname = inviteMap.get(usedInvite.code);
      if (!firstname) {
        console.log(`⚠ No firstname mapped for invite ${usedInvite.code}, falling back.`);
        firstname = member.displayName || member.user.username || "Client";
      } else {
        console.log(`Invite ${usedInvite.code} matched to firstname: ${firstname}`);
      }
    } else {
      console.log(`⚠ No used invite found for ${member.user.tag}, falling back.`);
      firstname = member.displayName || member.user.username || "Client";
    }

    firstname = firstname.trim();
    const categoryName = `${firstname} - ${BUSINESS_NAME}`;

    console.log(`Creating Nomads category/channels for: ${firstname}`);

    // ========================
    // CREATE CATEGORY
    // ========================
    const category = await guild.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory
    });

    // Permissions
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: member.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
      },
      {
        id: client.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
      }
    ];

    if (STAFF_ROLE_ID) {
      overwrites.push({
        id: STAFF_ROLE_ID,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
      });
    }

    await category.permissionOverwrites.set(overwrites);

    // ========================
    // CREATE CHANNELS (only 1, personalised)
    // ========================
    const personalised = slugifyName(firstname);
    const channelName = `🤝│nomads-${personalised}`;

    const teamChatChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id
    });

    // ========================
    // SEND ONBOARDING MESSAGE (one message)
    // ========================
    const newMemberMention = `<@${member.id}>`;
    const founders = mentionUsers(FOUNDER_USER_IDS, "Founder");
    const csms = mentionUsers(CSM_USER_IDS, "CSM");
    const ops = mentionUser(OPERATIONS_USER_ID, "Operations");
    const startHere = mentionChannel(START_HERE_CHANNEL_ID, "#start-here");

    const message = `
✨ **Welcome to ${BUSINESS_NAME}!**

Hey ${newMemberMention}, welcome aboard.

👥 **Your Team**
${founders} – **Founder**  
${csms} – **Client Success**  
${ops} – **Operations**

**Next step:** Head over to ${startHere} to complete your intake form.
    `.trim();

    await teamChatChannel.send(message);

    console.log(`✅ Created category + channel for ${firstname}`);
  } catch (err) {
    console.error("Error in guildMemberAdd:", err);
  }
});

// ========================
// LOGIN BOT
// ========================
client.login(DISCORD_TOKEN);
