/**
 * Twitter数据分析和总结系统
 * 
 * 核心功能:
 * 1. 定时从SQLite数据库读取Twitter数据
 * 2. 使用DeepSeek AI模型生成分析总结
 * 3. 将生成的总结存储到数据库
 * 4. 提供Web界面查看总结结果
 */

//-----------------------------------------------------------------------------
// 模块导入
//-----------------------------------------------------------------------------
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { default: OpenAI } = require('openai');
const schedule = require('node-schedule');

// 自定义模块
const { createLogger } = require('./logger');
const { DatabaseManager } = require('./data');
const { SYSTEM_PROMPT, AI_CONFIG } = require('./config');

// 设置日志记录器
const logger = createLogger('summary');

//-----------------------------------------------------------------------------
// 请求节流控制功能
//-----------------------------------------------------------------------------
class RequestThrottler {
    constructor(maxConcurrent = 2) {
        this.maxConcurrent = maxConcurrent;
        this.currentRequests = 0;
        this.requestQueue = [];
    }

    async acquireRequest() {
        if (this.currentRequests < this.maxConcurrent) {
            this.currentRequests++;
            return true;
        } else {
            return new Promise(resolve => {
                this.requestQueue.push(resolve);
            });
        }
    }

    releaseRequest() {
        if (this.requestQueue.length > 0) {
            const nextRequest = this.requestQueue.shift();
            nextRequest(true);
        } else {
            this.currentRequests--;
        }
    }
}

//-----------------------------------------------------------------------------
// 核心总结器类
//-----------------------------------------------------------------------------
class TwitterSummarizer {
    constructor() {
        this._initializeAIClient();
        this._initializeDatabase();
        this.throttler = new RequestThrottler(1);
        this.lastSummaryTime = {
            '1hour': new Date(),
            '12hours': new Date(),
            '1day': new Date()
        };
        this.scheduleJobs();
    }

    _initializeAIClient() {
        const apiKey = process.env.DEEPSEEK_API_KEY;
        if (!apiKey) {
            throw new Error("DEEPSEEK_API_KEY not found in environment variables");
        }

        this.client = new OpenAI({
            apiKey: apiKey,
            baseURL: "https://api.deepseek.com",
            timeout: 300000, // 5分钟超时
            maxRetries: 3,
            defaultHeaders: {
                "User-Agent": "Mozilla/5.0 CT-Twitter-Summarizer/1.0"
            },
            defaultQuery: {
                stream: false
            }
        });
    }

    _initializeDatabase() {
        try {
            const dbPath = path.join('data', 'twitter_data.db');
            if (!fs.existsSync(dbPath)) {
                logger.warn(`数据库文件 ${dbPath} 不存在，请确保爬虫已抓取数据`);
            }
            this.db = new DatabaseManager(false);
            logger.info('TwitterSummarizer初始化成功');
        } catch (error) {
            logger.error('初始化数据库失败:', error);
            logger.warn('将继续运行，但某些功能可能不可用');
            this.db = null;
        }
    }

    scheduleJobs() {
        // 在启动时生成一次所有时间段的总结
        logger.info('生成启动时的初始总结...');
        this.generateAndSaveSummary('1hour').catch(err =>
            logger.error(`生成启动时的1小时总结失败: ${err.message}`));
        this.generateAndSaveSummary('12hours').catch(err =>
            logger.error(`生成启动时的12小时总结失败: ${err.message}`));
        this.generateAndSaveSummary('1day').catch(err =>
            logger.error(`生成启动时的1天总结失败: ${err.message}`));

        // 每小时在x:10分时生成1小时总结（例如1:10, 2:10, 3:10...）
        schedule.scheduleJob('10 * * * *', async () => {
            logger.info('执行定时任务: 生成1小时总结');
            await this.generateAndSaveSummary('1hour');
        });

        // 每12小时在x:10分时生成12小时总结 (每天0:10和12:10)
        schedule.scheduleJob('10 0,12 * * *', async () => {
            logger.info('执行定时任务: 生成12小时总结');
            await this.generateAndSaveSummary('12hours');
        });

        // 每24小时在0:10生成1天总结 (每天0:10)
        schedule.scheduleJob('10 0 * * *', async () => {
            logger.info('执行定时任务: 生成1天总结');
            await this.generateAndSaveSummary('1day');
        });

        logger.info('已设置定时总结任务');
    }

    async generateAndSaveSummary(period) {
        const canProceed = await this.throttler.acquireRequest();
        if (!canProceed) {
            logger.warn(`自动总结被拒绝：当前有其他总结正在进行中`);
            return null;
        }

        try {
            logger.info(`开始自动生成${period}总结...`);
            const now = new Date();
            const timeDelta = this._getTimeDeltaForPeriod(period);
            const queryStart = new Date(now.getTime() - timeDelta);

            const tweets = await this.getPeriodData(period);

            if (!tweets || tweets.length === 0) {
                logger.warn(`没有找到${period}内的推文数据，跳过总结生成`);
                await this._saveEmptySummary(period, queryStart, now);
                return null;
            }

            const summary = await this.generateSummary(period);
            const result = await this.db.saveSummary(
                period,
                summary,
                queryStart,
                now,
                tweets.length,
                'success'
            );

            logger.info(`${period}总结已成功生成并保存到数据库 (ID: ${result.id})`);
            return result;
        } catch (error) {
            logger.error(`自动生成${period}总结失败:`, error);
            await this._saveErrorSummary(period, error);
            return null;
        } finally {
            this.throttler.releaseRequest();
        }
    }

    async _saveEmptySummary(period, queryStart, now) {
        await this.db.saveSummary(
            period,
            `<div class="no-data-message"><h3>📭 没有新数据</h3><p>在过去${period}内没有发现新的推文活动</p></div>`,
            queryStart,
            now,
            0,
            'empty'
        );
    }

    async _saveErrorSummary(period, error) {
        try {
            const now = new Date();
            const timeDelta = this._getTimeDeltaForPeriod(period);
            const queryStart = new Date(now.getTime() - timeDelta);

            await this.db.saveSummary(
                period,
                `<div class="error-message"><h3>❌ 生成总结时出错</h3><p>${error.message}</p></div>`,
                queryStart,
                now,
                0,
                'error'
            );
        } catch (dbError) {
            logger.error(`保存错误总结到数据库失败:`, dbError);
        }
    }

    _getTimeDeltaForPeriod(period) {
        const timeDelta = {
            '1hour': 60 * 60 * 1000,
            '12hours': 12 * 60 * 60 * 1000,
            '1day': 24 * 60 * 60 * 1000
        };
        return timeDelta[period] || timeDelta['1hour'];
    }

    async getPeriodData(period) {
        const now = new Date();
        const delta = this._getTimeDeltaForPeriod(period);
        const queryStart = new Date(now.getTime() - delta);

        logger.info(`开始查询过去${period}的推文数据 (${queryStart.toISOString()} 至 ${now.toISOString()})`);

        try {
            if (!this.db) {
                logger.error('数据库未初始化，无法获取数据');
                return [];
            }

            logger.info(`正在从数据库获取时间范围内的推文...`);
            const tweets = await this.db.getTweetsInTimeRange(queryStart, now);

            this._logTweetResults(tweets, period);
            this.lastSummaryTime[period] = now;
            return tweets;
        } catch (error) {
            logger.error(`获取${period}数据时出错:`, error);
            return [];
        }
    }

    _logTweetResults(tweets, period) {
        if (tweets.length === 0) {
            logger.warn(`未找到指定时间范围内的推文数据 (${period})`);
        } else {
            logger.info(`获取到 ${tweets.length} 条推文，时间范围: ${period}`);
            this._logSampleTweets(tweets);
        }
    }

    _logSampleTweets(tweets) {
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

    async generateSummary(period) {
        try {
            logger.info(`开始为${period}生成总结...`);

            if (!this.db) {
                return this._getDbErrorHtml();
            }

            const tweets = await this.getPeriodData(period);

            if (!tweets || tweets.length === 0) {
                return this._getNoDataHtml(period);
            }

            logger.info(`准备为${period}内的${tweets.length}条推文生成AI总结`);
            const tweetsText = this._formatTweetsForAI(tweets);
            logger.debug(`生成的推文文本长度: ${tweetsText.length} 字符`);

            const userPrompt = `请分析过去${period}的以下Twitter推文并生成结构化市场总结：\n${tweetsText}`;
            logger.info('正在调用AI生成总结...');

            const content = await this._callAIWithRetry(userPrompt);
            logger.info(`AI总结生成完成，内容长度: ${content.length} 字符`);

            if (content.length > 100000) {
                logger.warn(`生成的内容过长 (${content.length} 字符)，可能导致传输问题`);
                return content.substring(0, 100000) + '...[内容过长，已截断]';
            }

            return content;
        } catch (error) {
            const errorMsg = `生成${period}总结时出错: ${error}`;
            logger.error(errorMsg);
            return this._getErrorHtml(error.message);
        }
    }

    _formatTweetsForAI(tweets) {
        return tweets.map(tweet => {
            const tweetUrl = `https://x.com/${tweet.screen_name}/status/${tweet.id}`;
            return `用户: ${tweet.username} (@${tweet.screen_name})\n` +
                `发布时间: ${tweet.created_at}\n` +
                `内容: ${tweet.text}\n` +
                `交互数据: ${tweet.like_count}点赞, ${tweet.retweet_count}转发, ${tweet.reply_count}回复` +
                (tweet.media_urls ? `\n媒体: ${tweet.media_urls}` : '') +
                `\n源: ${tweetUrl}` +
                '\n' + '='.repeat(30);
        }).join('\n');
    }

    async _callAIWithRetry(userPrompt) {
        const timeoutMs = 300000; // 5分钟超时
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('AI生成总结请求超时，请稍后重试')), timeoutMs)
        );

        const maxRetries = 2;
        let lastError = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    logger.info(`AI请求重试 ${attempt}/${maxRetries}...`);
                    await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
                }

                const response = await Promise.race([
                    this.client.chat.completions.create({
                        model: AI_CONFIG.model,
                        messages: [
                            { role: "system", content: SYSTEM_PROMPT },
                            { role: "user", content: userPrompt }
                        ],
                        temperature: AI_CONFIG.temperature,
                        max_tokens: 4000,
                        timeout: 300000
                    }),
                    timeoutPromise
                ]);

                if (!response || !response.choices || !response.choices[0] || !response.choices[0].message) {
                    logger.error('API返回数据无效:', JSON.stringify(response).substring(0, 500));
                    throw new Error('API返回结构不符合预期');
                }

                return response.choices[0].message.content;
            } catch (retryError) {
                lastError = retryError;
                logger.error(`AI调用尝试 ${attempt + 1}/${maxRetries + 1} 失败:`, retryError.message);

                const isNetworkError = retryError.message.includes('ECONNRESET') ||
                    retryError.message.includes('socket hang up') ||
                    retryError.message.includes('timeout');

                if (attempt === maxRetries || !isNetworkError) {
                    throw retryError;
                }
            }
        }

        throw lastError || new Error("所有重试尝试均失败");
    }

    _getDbErrorHtml() {
        return `<div class="error-message">
            <h3>😕 无法获取数据</h3>
            <p>数据库连接失败。请检查以下问题：</p>
            <ul>
                <li>确保数据库文件存在</li>
                <li>检查日志文件获取更多信息</li>
                <li>确保已运行爬虫收集数据</li>
            </ul>
        </div>`;
    }

    _getNoDataHtml(period) {
        return `<div class="no-data-message">
            <h3>📭 没有新数据</h3>
            <p>在过去${period}内没有发现新的推文活动</p>
        </div>`;
    }

    _getErrorHtml(message) {
        return `<div class="error-message">
            <h3>❌ 生成总结时出错</h3>
            <p>${message}</p>
        </div>`;
    }

    cleanup() {
        if (this.db) {
            this.db.close();
        }
    }
}

//-----------------------------------------------------------------------------
// Web服务器设置
//-----------------------------------------------------------------------------
function setupWebServer(summarizer) {
    const app = express();
    app.use(express.json());
    app.use(express.static('public'));

    _configureServer(app);
    _setupRoutes(app, summarizer);

    return app;
}

function _configureServer(app) {
    // 增加请求超时设置 - 解决502错误问题
    app.use((req, res, next) => {
        req.setTimeout(300000);
        res.setTimeout(300000);
        next();
    });

    // 确保公共目录存在
    if (!fs.existsSync('public')) {
        fs.mkdirSync('public', { recursive: true });
        logger.info('已创建public目录');
    }
}

function _setupRoutes(app, summarizer) {
    // 健康检查端点
    app.get('/health', (req, res) => {
        res.status(200).json({
            status: 'ok',
            serverTime: new Date().toISOString(),
            uptime: process.uptime()
        });
    });

    // 获取指定时间段的总结
    app.get('/api/summary/:period', async (req, res) => {
        const { period } = req.params;
        const validPeriods = ['1hour', '12hours', '1day'];

        if (!validPeriods.includes(period)) {
            return res.status(400).json({ error: '无效的时间段' });
        }

        if (!summarizer || !summarizer.db) {
            return res.status(500).json({ error: 'Twitter总结器未初始化或数据库连接失败' });
        }

        try {
            logger.info(`接收到Web请求：获取${period}总结`);
            const summary = await summarizer.db.getLatestSummary(period);

            if (!summary) {
                logger.warn(`未找到${period}的总结记录，尝试生成新总结`);
                const result = await summarizer.generateAndSaveSummary(period);

                if (!result) {
                    return res.status(404).json({
                        error: `未找到${period}总结，自动生成也失败了`,
                        message: '请稍后再试'
                    });
                }

                const newSummary = await summarizer.db.getLatestSummary(period);
                if (!newSummary) {
                    return res.status(500).json({ error: '生成总结后无法获取结果' });
                }

                return res.json(_formatSummaryResponse(newSummary));
            }

            return res.json(_formatSummaryResponse(summary));
        } catch (error) {
            logger.error(`处理Web请求时出错:`, error);
            return res.status(500).json({ error: '获取总结时出错: ' + error.message });
        }
    });

    // 获取指定时间段的总结历史记录
    app.get('/api/summary/:period/history', async (req, res) => {
        const { period } = req.params;
        const limit = parseInt(req.query.limit || '10', 10);
        const validPeriods = ['1hour', '12hours', '1day'];

        if (!validPeriods.includes(period)) {
            return res.status(400).json({ error: '无效的时间段' });
        }

        if (!summarizer || !summarizer.db) {
            return res.status(500).json({ error: 'Twitter总结器未初始化或数据库连接失败' });
        }

        try {
            logger.info(`接收到Web请求：获取${period}总结历史 (限制: ${limit}条)`);
            const history = await summarizer.db.getSummaryHistory(period, limit);

            return res.json({
                period,
                count: history.length,
                history: history.map(item => ({
                    id: item.id,
                    created_at: item.created_at,
                    formatted_time: new Date(item.created_at).toLocaleString(),
                    tweet_count: item.tweet_count,
                    status: item.status,
                    start_time: item.start_time,
                    end_time: item.end_time
                }))
            });
        } catch (error) {
            logger.error(`处理获取历史记录请求时出错:`, error);
            return res.status(500).json({ error: '获取总结历史记录时出错: ' + error.message });
        }
    });

    // 手动触发生成新总结
    app.post('/api/summary/:period/generate', async (req, res) => {
        const { period } = req.params;
        const validPeriods = ['1hour', '12hours', '1day'];

        if (!validPeriods.includes(period)) {
            return res.status(400).json({ error: '无效的时间段' });
        }

        if (!summarizer) {
            return res.status(500).json({ error: 'Twitter总结器未初始化' });
        }

        try {
            logger.info(`接收到Web请求：手动生成${period}总结`);
            const result = await summarizer.generateAndSaveSummary(period);

            if (!result) {
                return res.status(500).json({ error: '生成总结失败' });
            }

            return res.json({
                success: true,
                message: `已成功生成${period}总结`,
                id: result.id,
                created_at: result.created_at
            });
        } catch (error) {
            logger.error(`处理手动生成总结请求时出错:`, error);
            return res.status(500).json({ error: '手动生成总结时出错: ' + error.message });
        }
    });
}

function _formatSummaryResponse(summary) {
    const createdAt = new Date(summary.created_at);
    const formattedTime = createdAt.toLocaleString();

    return {
        summary: summary.content,
        created_at: summary.created_at,
        formatted_time: formattedTime,
        tweet_count: summary.tweet_count,
        period: summary.period
    };
}

//-----------------------------------------------------------------------------
// 入口点函数
//-----------------------------------------------------------------------------
function main() {
    try {
        logger.info('正在启动Twitter数据分析和总结系统...');
        const summarizer = new TwitterSummarizer();
        const app = setupWebServer(summarizer);

        const PORT = process.env.PORT || 5000;
        const server = app.listen(PORT, () => {
            logger.info(`服务器运行在端口 ${PORT}`);
            logger.info(`访问 http://localhost:${PORT} 以使用Web界面`);
        });

        // 设置服务器超时处理
        server.timeout = 300000; // 5分钟
        server.keepAliveTimeout = 300000;
        server.headersTimeout = 300000;

        // 设置进程退出处理
        process.on('SIGINT', () => {
            logger.info('正在关闭服务...');
            summarizer.cleanup();
            server.close();
            process.exit(0);
        });

        logger.info('系统启动完成');
    } catch (error) {
        logger.error('系统启动失败:', error);
        process.exit(1);
    }
}

// 如果是直接运行此文件，则执行主函数
if (require.main === module) {
    main();
}

// 导出模块
module.exports = {
    TwitterSummarizer,
    setupWebServer
};
