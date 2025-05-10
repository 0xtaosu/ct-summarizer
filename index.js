/**
 * Twitter数据分析和总结系统
 * 
 * 主要功能:
 * 1. 从SQLite数据库读取Twitter数据
 * 2. 使用DeepSeek AI模型生成分析总结
 * 3. 提供Web界面查看总结结果
 */

// 加载环境变量和模块
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { default: OpenAI } = require('openai');
const schedule = require('node-schedule');
const winston = require('winston');

// 设置日志记录器
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({ filename: 'app.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

/**
 * Twitter 数据处理器类
 * 从SQLite数据库读取Twitter数据进行处理
 */
class TwitterDataProcessor {
    constructor() {
        this.dataDir = "data";
        this.dbPath = path.join(this.dataDir, "twitter_data.db");

        // 如果数据目录不存在，则创建
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
            logger.info('已创建数据目录');
        }

        this.initDatabase();
    }

    /**
     * 初始化数据库连接
     * 尝试连接到SQLite数据库并检查连接是否成功
     */
    initDatabase() {
        try {
            // 打开数据库连接（只读模式）
            this.db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) {
                    logger.error(`连接数据库失败: ${err.message}`);
                    throw err;
                }
                logger.info(`已连接到数据库: ${this.dbPath}`);

                // 连接成功后，查询表结构以验证
                this.db.get("PRAGMA table_info(tweets)", (err, row) => {
                    if (err) {
                        logger.error(`检查tweets表结构失败: ${err.message}`);
                    } else {
                        logger.info("成功验证tweets表结构");
                    }
                });

                // 获取总记录数
                this.db.get("SELECT COUNT(*) as count FROM tweets", (err, row) => {
                    if (err) {
                        logger.error(`获取tweets总数失败: ${err.message}`);
                    } else {
                        logger.info(`数据库共有 ${row.count} 条推文记录`);
                    }
                });
            });
        } catch (error) {
            logger.error(`初始化数据库连接失败: ${error.message}`);
            this.db = null;
        }
    }

    /**
     * 关闭数据库连接
     * 确保在应用关闭时正确释放资源
     */
    closeDatabase() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    logger.error(`关闭数据库连接失败: ${err.message}`);
                } else {
                    logger.info('数据库连接已关闭');
                }
            });
        }
    }

    /**
     * 从数据库获取指定时间段的推文数据
     * 
     * @param {Date} startTime 开始时间
     * @param {Date} endTime 结束时间 (默认为当前时间)
     * @returns {Promise<Array>} 推文数据数组
     */
    async getTweetsInTimeRange(startTime, endTime = new Date()) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                logger.error('数据库未连接');
                return reject(new Error('数据库未连接'));
            }

            // 将日期转换为UTC时间戳，用于比较
            const startMs = startTime.getTime();
            const endMs = endTime.getTime();

            logger.debug(`查询时间范围: ${startTime.toISOString()} 至 ${endTime.toISOString()}`);
            logger.debug(`时间戳范围: ${startMs} 至 ${endMs}`);

            // 首先获取所有推文
            const query = `
                SELECT 
                    id, 
                    user_id, 
                    username, 
                    screen_name, 
                    text, 
                    created_at, 
                    retweet_count, 
                    like_count, 
                    reply_count, 
                    quote_count,
                    bookmark_count, 
                    view_count, 
                    collected_at, 
                    media_urls
                FROM tweets
                ORDER BY created_at DESC
            `;

            this.db.all(query, [], (err, rows) => {
                if (err) {
                    logger.error(`查询数据库失败: ${err.message}`);
                    return reject(err);
                }

                logger.info(`从数据库获取到 ${rows.length} 条记录，开始过滤时间范围...`);

                // 输出前5条记录的created_at供调试
                if (rows.length > 0) {
                    const sampleDates = rows.slice(0, 5).map(r => r.created_at);
                    logger.debug(`样本日期格式: ${JSON.stringify(sampleDates)}`);
                }

                // 过滤指定时间范围内的推文
                // Twitter的日期格式例如: "Fri May 09 20:18:10 +0000 2025"
                const filteredRows = rows.filter(row => {
                    try {
                        // 直接使用JavaScript Date对象解析Twitter日期格式
                        const tweetDate = new Date(row.created_at);
                        const tweetMs = tweetDate.getTime();

                        // 检查是否在时间范围内
                        const isInRange = tweetMs >= startMs && tweetMs <= endMs;

                        // 为了调试，记录一些日期处理信息
                        if (rows.indexOf(row) < 5) {
                            logger.debug(`推文日期: ${row.created_at}`);
                            logger.debug(`解析为: ${tweetDate.toISOString()}`);
                            logger.debug(`时间戳: ${tweetMs}, 是否在范围内: ${isInRange}`);
                        }

                        return isInRange;
                    } catch (e) {
                        logger.warn(`无法解析推文日期: ${row.created_at}, 错误: ${e.message}`);
                        return false;
                    }
                });

                logger.info(`时间范围过滤后剩余 ${filteredRows.length} 条推文记录`);
                resolve(filteredRows);
            });
        });
    }

    /**
     * 获取指定用户的最新推文
     * @param {string} username 用户名
     * @param {number} limit 返回记录数限制
     * @returns {Promise<Array>} 推文数据数组
     */
    async getUserLatestTweets(username, limit = 10) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                logger.error('数据库未连接');
                return reject(new Error('数据库未连接'));
            }

            const query = `
                SELECT 
                    id, 
                    user_id, 
                    username, 
                    screen_name, 
                    text, 
                    created_at, 
                    retweet_count, 
                    like_count, 
                    reply_count, 
                    quote_count,
                    bookmark_count, 
                    view_count, 
                    collected_at, 
                    media_urls
                FROM tweets 
                WHERE screen_name = ? 
                ORDER BY created_at DESC 
                LIMIT ?
            `;

            this.db.all(query, [username, limit], (err, rows) => {
                if (err) {
                    logger.error(`查询用户 ${username} 的推文失败: ${err.message}`);
                    return reject(err);
                }

                logger.info(`获取到用户 ${username} 的 ${rows.length} 条最新推文`);
                resolve(rows);
            });
        });
    }

    /**
     * 获取热门推文
     * @param {number} limit 返回记录数限制
     * @param {string} metric 排序指标 (like_count, retweet_count, reply_count, quote_count, view_count)
     * @returns {Promise<Array>} 推文数据数组
     */
    async getPopularTweets(limit = 10, metric = 'like_count') {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                logger.error('数据库未连接');
                return reject(new Error('数据库未连接'));
            }

            // 验证排序指标
            const validMetrics = ['like_count', 'retweet_count', 'reply_count', 'quote_count', 'view_count'];
            if (!validMetrics.includes(metric)) {
                logger.error(`无效的排序指标: ${metric}`);
                return reject(new Error(`无效的排序指标: ${metric}`));
            }

            const query = `
                SELECT 
                    id, 
                    user_id, 
                    username, 
                    screen_name, 
                    text, 
                    created_at, 
                    retweet_count, 
                    like_count, 
                    reply_count, 
                    quote_count,
                    bookmark_count, 
                    view_count, 
                    collected_at, 
                    media_urls
                FROM tweets 
                ORDER BY ${metric} DESC 
                LIMIT ?
            `;

            this.db.all(query, [limit], (err, rows) => {
                if (err) {
                    logger.error(`查询热门推文失败: ${err.message}`);
                    return reject(err);
                }

                logger.info(`获取到 ${rows.length} 条热门推文 (按 ${metric} 排序)`);
                resolve(rows);
            });
        });
    }

    /**
     * 搜索推文内容
     * @param {string} keyword 关键词
     * @param {number} limit 返回记录数限制
     * @returns {Promise<Array>} 推文数据数组
     */
    async searchTweets(keyword, limit = 50) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                logger.error('数据库未连接');
                return reject(new Error('数据库未连接'));
            }

            const query = `
                SELECT 
                    id, 
                    user_id, 
                    username, 
                    screen_name, 
                    text, 
                    created_at, 
                    retweet_count, 
                    like_count, 
                    reply_count, 
                    quote_count,
                    bookmark_count, 
                    view_count, 
                    collected_at, 
                    media_urls
                FROM tweets 
                WHERE text LIKE ? 
                ORDER BY created_at DESC
                LIMIT ?
            `;

            this.db.all(query, [`%${keyword}%`, limit], (err, rows) => {
                if (err) {
                    logger.error(`搜索推文失败: ${err.message}`);
                    return reject(err);
                }

                logger.info(`搜索关键词 "${keyword}" 获取到 ${rows.length} 条推文`);
                resolve(rows);
            });
        });
    }
}

/**
 * Twitter 内容总结器类
 * 使用AI模型生成推文数据总结
 */
class TwitterSummarizer {
    /**
     * 构造函数
     * 初始化AI客户端和数据处理器
     */
    constructor() {
        // 初始化DeepSeek AI客户端
        const apiKey = process.env.DEEPSEEK_API_KEY;
        if (!apiKey) {
            throw new Error("DEEPSEEK_API_KEY not found in environment variables");
        }

        this.client = new OpenAI({
            apiKey: apiKey,
            baseURL: "https://api.deepseek.com"
        });

        this.lastSummaryTime = {
            '1hour': new Date()
        };

        // 初始化数据处理器
        try {
            this.dataProcessor = new TwitterDataProcessor();
            logger.info('TwitterSummarizer初始化成功');
        } catch (error) {
            logger.error('初始化组件失败:', error);
            this.dataProcessor = null;
        }
    }

    /**
     * 获取指定时间段的数据
     * @param {string} period 时间段
     * @returns {Promise<array>} 数据列表
     */
    async getPeriodData(period) {
        const now = new Date();
        const timeDelta = {
            '1hour': 60 * 60 * 1000, // 1小时的毫秒数
            '12hours': 12 * 60 * 60 * 1000,
            '1day': 24 * 60 * 60 * 1000
        };

        // 如果未指定有效时间段，默认为1小时
        const delta = timeDelta[period] || timeDelta['1hour'];
        const queryStart = new Date(now.getTime() - delta);

        logger.info(`开始查询过去${period}的推文数据 (${queryStart.toISOString()} 至 ${now.toISOString()})`);

        try {
            // 检查数据处理器是否存在
            if (!this.dataProcessor) {
                logger.error('数据处理器未初始化，无法获取数据');
                return [];
            }

            // 从数据库获取时间段内的推文
            logger.info(`正在从数据库获取时间范围内的推文...`);
            const tweets = await this.dataProcessor.getTweetsInTimeRange(queryStart, now);

            if (tweets.length === 0) {
                logger.warn(`未找到指定时间范围内的推文数据 (${period})`);
            } else {
                logger.info(`获取到 ${tweets.length} 条推文，时间范围: ${period}`);

                // 记录前几条推文的基本信息
                const sampleCount = Math.min(tweets.length, 3);
                for (let i = 0; i < sampleCount; i++) {
                    const tweet = tweets[i];
                    logger.debug(`示例推文 #${i + 1}:`);
                    logger.debug(`  用户: ${tweet.username} (@${tweet.screen_name})`);
                    logger.debug(`  时间: ${tweet.created_at}`);
                    logger.debug(`  内容: ${tweet.text.substring(0, 50)}...`);
                    logger.debug(`  交互: 👍${tweet.like_count} 🔁${tweet.retweet_count} 💬${tweet.reply_count}`);
                }
            }

            this.lastSummaryTime[period] = now;
            return tweets;
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
            logger.info(`开始为${period}生成总结...`);

            // 获取时间段内的推文数据
            const tweets = await this.getPeriodData(period);

            // 检查是否有数据
            if (!tweets || tweets.length === 0) {
                logger.warn(`没有找到${period}内的推文数据，无法生成总结`);
                return `在过去${period}内没有新的推文活动`;
            }

            logger.info(`准备为${period}内的${tweets.length}条推文生成AI总结`);

            // 格式化推文数据用于AI分析
            const tweetsText = tweets.map(tweet =>
                `用户: ${tweet.username} (@${tweet.screen_name})\n` +
                `发布时间: ${tweet.created_at}\n` +
                `内容: ${tweet.text}\n` +
                `交互数据: ${tweet.like_count}点赞, ${tweet.retweet_count}转发, ${tweet.reply_count}回复` +
                (tweet.media_urls ? `\n媒体: ${tweet.media_urls}` : '') +
                '\n' + '='.repeat(30)
            ).join('\n');

            // 记录要发送到AI的数据长度
            logger.debug(`生成的推文文本长度: ${tweetsText.length} 字符`);

            // AI提示词系统信息
            const systemPrompt = `
目标：总结指定时间段内的Twitter推文内容，提取关键事件，识别涉及的代币或项目，并提供上下文和相关详细信息。输出需采用 HTML 格式，适配网页和消息展示。

分析步骤：
1. 推文事件总结：
- 提取过去指定时间段内的所有关键推文主题
- 按主题分类（市场趋势/技术突破/政策动态/突发新闻）
- 简洁明了地概述每个主题的核心信息

2. 代币或项目提取：
- 从推文内容中识别并提取任何提到的代币名称或项目
- 验证代币或项目的可信度，例如是否获得行业认可或具有明确链上记录

3. 补充上下文信息：
- 提供代币或项目的背景资料，例如技术特点、团队介绍、代币经济模型
- 分析推文中提及的代币或项目与事件之间的关系
- 整合相关热门推文的交互数据，分析社区讨论情况

请按以下HTML格式输出：

<b>😊 市场动态</b>
- [简要概述关键市场事件]

<b>🔥 热门代币/项目分析</b>

<b>1. [代币/项目名称]</b>
- <b>核心内容：</b> [简要描述代币/项目的主要新闻]
- <b>市场反响：</b>
  - <i>讨论聚焦：</i> [围绕该代币/项目的主要话题]
  - <i>社区情绪：</i> [情绪分析]
`;

            // 用户提示词
            const userPrompt = `请分析过去${period}的以下Twitter推文：\n${tweetsText}`;

            logger.info('正在调用AI生成总结...');
            const response = await this.client.chat.completions.create({
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.7
            });

            logger.info('AI总结生成完成');
            return response.choices[0].message.content;

        } catch (error) {
            const errorMsg = `生成${period}总结时出错: ${error}`;
            logger.error(errorMsg);
            return errorMsg;
        }
    }

    /**
     * 清理资源
     */
    cleanup() {
        if (this.dataProcessor) {
            this.dataProcessor.closeDatabase();
        }
    }
}

/**
 * 创建和配置Web服务器
 */
function setupWebServer(summarizer) {
    // 创建 Express 应用
    const app = express();
    app.use(express.json());
    app.use(express.static('public')); // 为静态文件提供服务

    // 创建公共目录和HTML文件
    if (!fs.existsSync('public')) {
        fs.mkdirSync('public', { recursive: true });
        logger.info('已创建public目录');
    }

    // 创建HTML页面
    const htmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Twitter 总结器</title>
    <style>
        body {
            font-family: 'Arial', sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f5f8fa;
            color: #14171a;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background-color: #fff;
            border-radius: 12px;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
            padding: 25px;
        }
        header {
            text-align: center;
            margin-bottom: 30px;
            border-bottom: 1px solid #e1e8ed;
            padding-bottom: 20px;
        }
        h1 {
            color: #1da1f2;
            margin: 0;
        }
        .btn {
            background-color: #1da1f2;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 20px;
            cursor: pointer;
            font-size: 16px;
            font-weight: bold;
            transition: background-color 0.2s;
            margin: 10px 0;
            width: 100%;
        }
        .btn:hover {
            background-color: #1991db;
        }
        .btn:disabled {
            background-color: #9ad2f6;
            cursor: not-allowed;
        }
        #summary {
            margin-top: 20px;
            padding: 15px;
            border: 1px solid #e1e8ed;
            border-radius: 8px;
            background-color: #f5f8fa;
            min-height: 100px;
        }
        .loading {
            text-align: center;
            color: #657786;
            font-style: italic;
        }
        .timestamp {
            color: #657786;
            font-size: 14px;
            text-align: right;
            margin-top: 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Twitter 总结器</h1>
            <p>获取最新Twitter动态的AI摘要</p>
        </header>
        
        <div>
            <button id="hourBtn" class="btn">获取最近1小时总结</button>
            <div id="summary">
                <p>点击上方按钮获取最新总结...</p>
            </div>
            <div class="timestamp" id="timestamp"></div>
        </div>
    </div>

    <script>
        document.getElementById('hourBtn').addEventListener('click', async function() {
            const button = this;
            const summaryDiv = document.getElementById('summary');
            const timestampDiv = document.getElementById('timestamp');
            
            // 禁用按钮并显示加载状态
            button.disabled = true;
            summaryDiv.innerHTML = '<p class="loading">AI正在生成总结，请稍候...</p>';
            
            try {
                // 调用API获取1小时总结
                const response = await fetch('/api/summary/1hour');
                
                if (!response.ok) {
                    throw new Error('获取总结失败');
                }
                
                const data = await response.json();
                
                // 更新界面
                summaryDiv.innerHTML = data.summary;
                timestampDiv.textContent = '更新时间: ' + new Date().toLocaleString();
            } catch (error) {
                summaryDiv.innerHTML = '<p style="color: red;">获取总结失败: ' + error.message + '</p>';
            } finally {
                // 重新启用按钮
                button.disabled = false;
            }
        });
    </script>
</body>
</html>
`;

    fs.writeFileSync('public/index.html', htmlContent);
    logger.info('创建/更新了web界面文件');

    // API接口 - 获取指定时间段的总结
    app.get('/api/summary/:period', async (req, res) => {
        const period = req.params.period;
        const validPeriods = ['1hour', '12hours', '1day'];

        if (!validPeriods.includes(period)) {
            return res.status(400).json({ error: '无效的时间段' });
        }

        if (!summarizer) {
            return res.status(500).json({ error: 'Twitter总结器未初始化' });
        }

        try {
            logger.info(`接收到Web请求：获取${period}总结`);
            const summary = await summarizer.generateSummary(period);
            return res.json({ summary });
        } catch (error) {
            logger.error(`处理Web请求时出错:`, error);
            return res.status(500).json({ error: '生成总结时出错' });
        }
    });

    return app;
}

/**
 * 应用程序主入口
 */
function main() {
    logger.info('启动Twitter总结应用...');

    // 创建summarizer实例
    let summarizer;
    try {
        summarizer = new TwitterSummarizer();
        logger.info('Twitter总结器已成功初始化');
    } catch (error) {
        logger.error('初始化Twitter总结器失败:', error);
        return;
    }

    // 设置Web服务器
    const app = setupWebServer(summarizer);

    // 处理程序退出
    process.on('SIGINT', () => {
        logger.info('接收到中断信号，正在关闭...');
        if (summarizer) {
            summarizer.cleanup();
        }
        process.exit(0);
    });

    // 启动服务器
    const PORT = process.env.PORT || 5001;
    app.listen(PORT, () => {
        console.log(`服务器运行在端口 ${PORT}`);
        console.log(`访问 http://localhost:${PORT} 以使用Web界面`);
    });
}

// 执行主函数
main();
