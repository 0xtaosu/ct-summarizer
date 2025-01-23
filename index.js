// 加载环境变量和模块
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');
const { OpenAI } = require('openai');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const winston = require('winston');

// 设置日志记录器
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'webhook.log' })
    ]
});

/**
 * Telegram Bot 处理类
 */
class TelegramBotHandler {
    constructor() {
        this.token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;

        if (!this.token || !this.chatId) {
            throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not found in environment variables");
        }

        this.bot = new TelegramBot(this.token, { polling: false });
    }

    /**
     * 发送消息到 Telegram
     * @param {string} text 消息内容
     * @returns {Promise<boolean>} 是否发送成功
     */
    async sendMessage(text) {
        try {
            await this.bot.sendMessage(this.chatId, text, { parse_mode: 'HTML' });
            logger.info("Telegram消息发送成功");
            return true;
        } catch (error) {
            logger.error('发送Telegram消息失败:', error);
            return false;
        }
    }

    /**
     * 发送总结到 Telegram
     * @param {string} period 时间段
     * @param {string} summary 总结内容
     */
    sendSummary(period, summary) {
        const periodInfo = {
            '1hour': ['1小时', '🕐']
        }[period] || [period, '🔔'];

        const [periodDisplay, emoji] = periodInfo;

        // 清理和格式化 HTML 内容
        const cleanHtml = (text) => {
            if (text.includes('<!DOCTYPE') || text.includes('!doctype')) {
                text = text.split('>', 1)[1];
            }
            text = text.replace(/<html>/g, '').replace(/<\/html>/g, '');
            text = text.replace(/<body>/g, '').replace(/<\/body>/g, '');
            return text.trim();
        };

        // 构建消息内容
        const message = 
            `${emoji} <b>Twitter ${periodDisplay}快讯</b>\n\n` +
            `📅 分析时间: ${new Date().toISOString()}\n` +
            `📊 分析范围: 最近${periodDisplay}的数据\n` +
            `${'—'.repeat(32)}\n\n` +
            `${cleanHtml(summary)}\n\n` +
            `${'—'.repeat(32)}\n` +
            `🤖 由 Grok AI 提供分析支持`;

        this.sendMessage(message).catch(error => {
            logger.error(`发送${periodDisplay}总结到Telegram失败:`, error);
            logger.debug('消息内容:', message);
            logger.debug('原始summary:', summary);
        });
    }
}

/**
 * Twitter 数据处理器类
 */
class TwitterDataProcessor {
    constructor() {
        this.dataDir = "data";
        this.twitterFile = path.join(this.dataDir, "twitter_data.csv");

        // 如果数据目录不存在，则创建
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }

        // 定义 CSV 文件的列
        this.columns = [
            'timestamp',
            'user_name',
            'user_description',
            'event_type',
            'content'
        ];

        // 初始化 CSV 写入器
        this.csvWriter = createObjectCsvWriter({
            path: this.twitterFile,
            header: this.columns.map(id => ({ id, title: id })),
            append: true
        });

        this.initCsvFile();
    }

    /**
     * 初始化 CSV 文件
     */
    initCsvFile() {
        if (!fs.existsSync(this.twitterFile)) {
            const headers = this.columns.join(',') + '\n';
            fs.writeFileSync(this.twitterFile, headers);
        }
    }

    /**
     * 处理 webhook 数据
     * @param {object} data webhook 数据
     * @returns {Promise<boolean>} 是否处理成功
     */
    async processWebhookData(data) {
        try {
            const timestamp = new Date(
                data.tweet?.publish_time * 1000 || 
                data.user?.updated_at * 1000 || 
                Date.now()
            ).toISOString();

            const record = {
                timestamp,
                user_name: data.user?.name || '',
                user_description: data.user?.description || '',
                event_type: data.push_type || '',
                content: data.tweet?.text || data.content || ''
            };

            await this.csvWriter.writeRecords([record]);
            logger.info(`数据已保存 - 事件类型: ${record.event_type}`);
            return true;
        } catch (error) {
            logger.error('处理数据时出错:', error);
            return false;
        }
    }
}

/**
 * Twitter 内容总结器类
 */
class TwitterSummarizer {
    constructor() {
        const apiKey = process.env.XAI_API_KEY;
        if (!apiKey) {
            throw new Error("XAI_API_KEY not found in environment variables");
        }

        this.client = new OpenAI({
            apiKey: apiKey,
            baseURL: "https://api.x.ai/v1"
        });

        this.lastSummaryTime = {
            '1hour': new Date()
        };

        try {
            this.telegram = new TelegramBotHandler();
        } catch (error) {
            logger.error('初始化Telegram Bot失败:', error);
            this.telegram = null;
        }

        this.startScheduledSummaries();
    }

    /**
     * 获取指定时间段的数据
     * @param {string} period 时间段
     * @returns {array} 数据列表
     */
    getPeriodData(period) {
        const now = new Date();
        const timeDelta = {
            '1hour': 60 * 60 * 1000 // 1小时的毫秒数
        };

        const queryStart = new Date(now - timeDelta[period]);

        try {
            const data = fs.readFileSync(path.join('data', 'twitter_data.csv'), 'utf-8');
            const lines = data.trim().split('\n');
            const headers = lines[0].split(',');

            const records = lines.slice(1).map(line => {
                const values = line.split(',');
                return headers.reduce((obj, header, index) => {
                    obj[header] = values[index];
                    return obj;
                }, {});
            });

            const newData = records.filter(record => 
                new Date(record.timestamp) > queryStart
            );

            this.lastSummaryTime[period] = now;
            return newData;
        } catch (error) {
            logger.error(`获取${period}数据时出错:`, error);
            return [];
        }
    }

    /**
     * 生成总结
     * @param {string} period 时间段
     * @returns {Promise<string>} 总结内容
     */
    async generateSummary(period) {
        try {
            const data = this.getPeriodData(period);
            if (data.length === 0) {
                return `在过去${period}内没有新的推文活动`;
            }

            const eventsText = data.map(e => 
                `发布者: ${e.user_name}\n` +
                `发布者简介: ${e.user_description}\n` +
                `事件类型: ${e.event_type}\n` +
                `发布时间: ${e.timestamp}\n` +
                `内容: ${e.content}\n` +
                '='.repeat(30)
            ).join('\n');

            const systemPrompt = `
目标：总结指定时间段内的新闻内容，提取关键事件，识别涉及的代币或项目，并结合社交媒体数据提供上下文和相关详细信息。输出需采用 HTML 格式，适配 Telegram 消息展示。

分析步骤：
1. 新闻事件总结：
- 提取过去指定时间段内的所有关键新闻事件
- 按主题分类（市场趋势/技术突破/政策动态/突发新闻）
- 简洁明了地概述每个事件的核心信息

2. 代币或项目提取：
- 从新闻内容中识别并提取任何提到的代币名称或项目
- 验证代币或项目的可信度，例如是否获得行业认可或具有明确链上记录

3. 补充上下文信息：
- 提供代币或项目的背景资料，例如技术特点、团队介绍、代币经济模型
- 分析新闻中提及的代币或项目与事件之间的关系
- 整合相关的社交媒体数据，例如 Twitter 链接和社区讨论内容

请按以下HTML格式输出：

<b>😊 市场动态</b>
- [简要概述关键市场事件]

<b>🔥 热门代币/项目分析</b>

<b>1. [代币/项目名称]</b>
- <b>核心内容：</b> [简要描述代币/项目的主要新闻]
- <b>市场反响：</b>
  - <i>讨论聚焦：</i> [围绕该代币/项目的主要话题]
  - <i>社区情绪：</i> [情绪分析]
- <b>相关新闻链接：</b>
  - <a href="链接1">[Twitter链接描述1]</a>
  - <a href="链接2">[Twitter链接描述2]</a>
`;

            const userPrompt = `请分析过去${period}的以下Twitter活动：\n${eventsText}`;

            const response = await this.client.chat.completions.create({
                model: "grok-2-latest",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.7
            });

            return response.choices[0].message.content;

        } catch (error) {
            const errorMsg = `生成${period}总结时出错: ${error}`;
            logger.error(errorMsg);
            return errorMsg;
        }
    }

    /**
     * 启动定时总结任务
     */
    startScheduledSummaries() {
        const generateAndSendSummary = async (period) => {
            const summary = await this.generateSummary(period);
            console.log(`\n=== ${period} 定时总结 ===`);
            console.log(`总结时间: ${new Date().toISOString()}`);
            console.log(summary);
            console.log('='.repeat(50));

            if (this.telegram) {
                this.telegram.sendSummary(period, summary);
            }
        };

        // 每小时执行一次
        schedule.scheduleJob('0 * * * *', () => generateAndSendSummary('1hour'));
        logger.info('定时总结任务已启动 (UTC)');
    }
}

// 创建 Express 应用
const app = express();
app.use(express.json());

// 创建数据处理器和总结器实例
const dataProcessor = new TwitterDataProcessor();
const summarizer = new TwitterSummarizer();

// Webhook 接收端点
app.post('/webhook/twitter', async (req, res) => {
    try {
        logger.info('=== 收到新的 Webhook 请求 ===');
        logger.info('请求方法:', req.method);
        logger.info('请求头:', req.headers);
        logger.info('JSON 数据:', req.body);

        const success = await dataProcessor.processWebhookData(req.body);
        if (success) {
            res.status(200).json({
                status: 'success',
                message: 'Data processed and saved',
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(500).json({
                status: 'error',
                message: 'Failed to process data'
            });
        }
    } catch (error) {
        logger.error('处理请求时发生错误:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// 启动服务器
const PORT = 5001;
app.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
});
