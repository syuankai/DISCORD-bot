const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Events } = require('discord.js');

// 載入 .env 檔案
dotenv.config();

// 讀取 config.json 設定檔 (若存在)
let fileConfig = {};
const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
  try {
    const rawData = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(rawData);
    console.log('[系統通知] 成功讀取本地 config.json 設定檔');
  } catch (err) {
    console.error('[錯誤] 讀取 config.json 失敗，請確認 JSON 格式是否正確:', err.message);
  }
}

// 設定優先順序: config.json > process.env > 預設值
const PORT = fileConfig.port || process.env.PORT || 3000;
const TUNNEL_MODE = fileConfig.tunnelMode ?? (process.env.TUNNEL_MODE === 'true');
const API_KEY = fileConfig.apiKey || process.env.API_KEY || '';
const APPLICATION_ID = fileConfig.applicationId || process.env.APPLICATION_ID || '';
const DISCORD_BOT_TOKEN = fileConfig.botToken || process.env.DISCORD_BOT_TOKEN || '';
const DEFAULT_CHANNEL_ID = fileConfig.defaultChannelId || process.env.DEFAULT_CHANNEL_ID || '';
const ENFORCE_GUILD_ID = fileConfig.enforceGuildId || process.env.ENFORCE_GUILD_ID || '';

const app = express();

// 1. 跨網域處理 (tunnelMode 為 true 時開放完全跨網域)
if (TUNNEL_MODE) {
  console.log('[安全模式] 已啟用「內網穿透模式 (tunnelMode)」，已停用 CORS 限制與 API Key 強制驗證！');
  app.use(cors()); // 允許所有跨網域請求
} else {
  app.use(cors()); // 可依需求加入特定 origin 限制
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 建立 Discord Client
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// 2. API 金鑰驗證中間件
const authenticateApiKey = (req, res, next) => {
  // 如果開啟 tunnelMode，則直接略過驗證
  if (TUNNEL_MODE) {
    return next();
  }

  const clientKey = req.headers['x-api-key'] || req.query.api_key;
  if (API_KEY && clientKey !== API_KEY) {
    return res.status(401).json({ success: false, message: '未授權：API 金鑰無效或缺漏' });
  }
  next();
};

/**
 * 檢查與取得目標頻道物件 (含強制群組驗證)
 * @param {string} reqChannelId - 請求帶入的頻道 ID
 */
async function resolveChannel(reqChannelId) {
  const targetChannelId = reqChannelId || DEFAULT_CHANNEL_ID;
  if (!targetChannelId) {
    throw new Error('未指定 channel_id，且未設定預設 DEFAULT_CHANNEL_ID');
  }

  const channel = await discordClient.channels.fetch(targetChannelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error('找不到指定的文字頻道');
  }

  // 強制群組檢查機制 (enforceGuildId)
  if (ENFORCE_GUILD_ID) {
    if (channel.guildId !== ENFORCE_GUILD_ID) {
      throw new Error(`系統已開啟強制群組限制 (ENFORCE_GUILD_ID=${ENFORCE_GUILD_ID})，禁止存取非該群組之頻道 (${channel.guildId})`);
    }
  }

  return channel;
}

// 健康檢查 Endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tunnelMode: TUNNEL_MODE,
    enforceGuildId: ENFORCE_GUILD_ID || null,
    applicationId: APPLICATION_ID || null,
    botOnline: discordClient.isReady(),
    timestamp: new Date()
  });
});

/**
 * 發送訊息 API (POST)
 */
app.post('/send-message', authenticateApiKey, async (req, res) => {
  try {
    const { message, channel_id } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, message: '缺少必填欄位：message' });
    }

    const channel = await resolveChannel(channel_id);
    const sentMessage = await channel.send(message);

    return res.json({
      success: true,
      message: '訊息已順利發送至 Discord',
      data: {
        id: sentMessage.id,
        guild_id: sentMessage.guildId,
        channel_id: sentMessage.channelId,
        content: sentMessage.content,
        timestamp: sentMessage.createdAt
      }
    });
  } catch (error) {
    console.error('發送 Discord 訊息失敗:', error.message);
    return res.status(500).json({ success: false, message: '發送訊息失敗', error: error.message });
  }
});

/**
 * 發送訊息 API (GET)
 */
app.get('/send-message', authenticateApiKey, async (req, res) => {
  try {
    const message = req.query.message;
    const reqChannelId = req.query.channel_id;

    if (!message) {
      return res.status(400).json({ success: false, message: '缺少必填參數：message' });
    }

    const channel = await resolveChannel(reqChannelId);
    const sentMessage = await channel.send(message);

    return res.json({
      success: true,
      message: '訊息已順利發送至 Discord',
      data: {
        id: sentMessage.id,
        guild_id: sentMessage.guildId,
        channel_id: sentMessage.channelId,
        content: sentMessage.content,
        timestamp: sentMessage.createdAt
      }
    });
  } catch (error) {
    console.error('發送 Discord 訊息失敗:', error.message);
    return res.status(500).json({ success: false, message: '發送訊息失敗', error: error.message });
  }
});

/**
 * 等待指定頻道中提及 (@) 機器人的訊息 (Long Polling / Wait)
 */
app.all('/wait-for-mention', authenticateApiKey, async (req, res) => {
  try {
    const reqChannelId = req.body?.channel_id || req.query?.channel_id;
    const timeoutMs = parseInt(req.body?.timeout || req.query?.timeout || '30000', 10);

    const channel = await resolveChannel(reqChannelId);
    const targetChannelId = channel.id;

    let isResponded = false;
    let timeoutTimer = null;

      const messageHandler = (message) => {
      // 忽略機器人自己的訊息
      if (message.author.bot) return;

      // 檢查頻道 ID 是否一致
      if (message.channelId !== targetChannelId) return;

      // 檢查是否包含強制群組限制
      if (ENFORCE_GUILD_ID && message.guildId !== ENFORCE_GUILD_ID) return;

      // 檢查是否 @ 標記了機器人
      const isMentioned = message.mentions.has(discordClient.user.id);
      if (!isMentioned) return;

      // 清理監聽器與超時定時器
      cleanup();
      isResponded = true;

      // 移除 @機器人 的文字，取得純內文
      const cleanedContent = message.content.replace(new RegExp(`<@!?${discordClient.user.id}>`, 'g'), '').trim();

      return res.json({
        success: true,
        event: 'mention_received',
        data: {
          message_id: message.id,
          guild_id: message.guildId,
          channel_id: message.channelId,
          author: {
            id: message.author.id,
            username: message.author.username,
            displayName: message.author.displayName
          },
          raw_content: message.content,
          cleaned_content: cleanedContent,
          timestamp: message.createdAt
        }
      });
    };

    const cleanup = () => {
      discordClient.off(Events.MessageCreate, messageHandler);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };

    discordClient.on(Events.MessageCreate, messageHandler);

    timeoutTimer = setTimeout(() => {
      if (!isResponded) {
        cleanup();
        return res.status(408).json({
          success: false,
          message: `在指定時間 (${timeoutMs / 1000} 秒) 內未收到提及 (@) 機器人的訊息`
        });
      }
    }, timeoutMs);

  } catch (error) {
    return res.status(400).json({ success: false, message: '初始化監聽失敗', error: error.message });
  }
});

// 當 Discord Client 準備完成
discordClient.once(Events.ClientReady, (readyClient) => {
  console.log(`[${new Date().toISOString()}] Discord 機器人已上線！登入名稱: ${readyClient.user.tag}`);
  
  app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] API 伺服器運作中，埠號: ${PORT}`);
  });
});

// 登入 Discord
if (!DISCORD_BOT_TOKEN) {
  console.error('[錯誤] 找不到 DISCORD_BOT_TOKEN，請檢查 config.json 或 .env 檔案');
  process.exit(1);
}

discordClient.login(DISCORD_BOT_TOKEN).catch((err) => {
  console.error('[錯誤] Discord 登入失敗：請確認 Bot Token 是否正確', err.message);
  process.exit(1);
});
