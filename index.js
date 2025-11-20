/**
 * Twitter 数据分析和总结系统
 * 
 * 核心功能：
 * - 定时从 SQLite 数据库读取 Twitter 推文数据
 * - 使用 Gemini AI 模型生成智能分析总结
 * - 将生成的总结存储到数据库
 * - 提供 Web API 和界面展示总结结果
 * - 支持多时间段总结（1小时、12小时、24小时）
 * 
 * @module index
 */

// ==================== 模块导入 ====================

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const schedule = require('node-schedule');

const { createLogger } = require('./logger');
const { DatabaseManager } = require('./data');
const { SYSTEM_PROMPT, AI_CONFIG } = require('./config');

const logger = createLogger('summary');

// ==================== 时间工具函数 ====================

/**
 * 时间处理工具集
 * 
 * 提供时间计算、格式化和北京时间转换功能
 * @constant {Object}
 */
const TimeUtil = {
    /**
     * 格式化日期为北京时间字符串（UTC+8）
     * @param {Date} date - Date 对象
     * @returns {string} 格式化的北京时间（如："2025/01/15 14:30:00"）
     */
    formatToBeiJingTime(date) {
        // 创建一个新日期并加上8小时时差
        const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
        return beijingDate.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
    },

    /**
     * 获取时间段对应的毫秒数
     * @param {string} period - 时间段标识
     * @returns {number} 毫秒数
     */
    getTimeDeltaForPeriod(period) {
        const timeDelta = {
            '1hour': 60 * 60 * 1000,
            '12hours': 12 * 60 * 60 * 1000,
            '1day': 24 * 60 * 60 * 1000
        };
        return timeDelta[period] || timeDelta['1hour'];
    },

    /**
     * 计算指定时间段的精确时间范围（基于整点时间）
     * @param {string} period - 时间段标识（'1hour', '12hours', '1day'）
     * @returns {Object} 时间范围对象 {start, end, beijingTimeRange, ...}
     */
    calculateTimeRange(period) {
        // 获取当前时间，计算最近的过去整点时间（上一个整点）
        const now = new Date();
        const lastHour = new Date(now);
        lastHour.setMinutes(0, 0, 0);

        // 如果当前时间的分钟是0，则上一个整点应该是当前小时的前一小时
        if (now.getMinutes() === 0 && now.getSeconds() === 0) {
            lastHour.setHours(lastHour.getHours() - 1);
        }

        // 计算开始时间和结束时间
        let queryStart, queryEnd;

        if (period === '1hour') {
            // 计算"上上个整点"作为开始时间
            queryEnd = new Date(lastHour); // 上一个整点作为结束时间
            queryStart = new Date(lastHour);
            queryStart.setHours(queryStart.getHours() - 1); // 上上个整点作为开始时间

            logger.info(`1小时范围：从${queryStart.toLocaleString()}到${queryEnd.toLocaleString()}`);
        } else if (period === '12hours') {
            // 计算12小时前的整点作为开始时间
            queryEnd = new Date(lastHour); // 上一个整点作为结束时间
            queryStart = new Date(lastHour);
            queryStart.setHours(queryStart.getHours() - 12); // 往前推12个整点小时

            logger.info(`12小时范围：从${queryStart.toLocaleString()}到${queryEnd.toLocaleString()}`);
        } else if (period === '1day') {
            // 计算24小时前的整点作为开始时间
            queryEnd = new Date(lastHour); // 上一个整点作为结束时间
            queryStart = new Date(lastHour);
            queryStart.setHours(queryStart.getHours() - 24); // 往前推24个整点小时

            logger.info(`24小时范围：从${queryStart.toLocaleString()}到${queryEnd.toLocaleString()}`);
        } else {
            // 默认情况：使用传统的相对时间计算
            const timeDelta = this.getTimeDeltaForPeriod(period);
            queryEnd = new Date(lastHour);
            queryStart = new Date(lastHour.getTime() - timeDelta);
        }

        // 创建北京时间版本（UTC+8）
        const beijingStart = new Date(queryStart.getTime() + 8 * 60 * 60 * 1000);
        const beijingEnd = new Date(queryEnd.getTime() + 8 * 60 * 60 * 1000);

        // 格式化北京时间，确保小时值使用两位数字
        const beijingStartHour = beijingStart.getHours().toString().padStart(2, '0');
        const beijingEndHour = beijingEnd.getHours().toString().padStart(2, '0');
        const beijingTimeRange = `${beijingStartHour}:00～${beijingEndHour}:00`;

        return {
            start: queryStart,
            end: queryEnd,
            startFormatted: queryStart.toISOString(),
            endFormatted: queryEnd.toISOString(),
            beijingStart: this.formatToBeiJingTime(queryStart),
            beijingEnd: this.formatToBeiJingTime(queryEnd),
            beijingTimeRange: beijingTimeRange
        };
    }
};

// ==================== 请求节流控制 ====================

/**
 * 请求节流器
 * 
 * 限制并发请求数量，防止系统过载
 */
class RequestThrottler {
    /**
     * 构造节流器
     * @param {number} [maxConcurrent=2] - 最大并发请求数
     */
    constructor(maxConcurrent = 2) {
        this.maxConcurrent = maxConcurrent;
        this.currentRequests = 0;
        this.requestQueue = [];
    }

    /**
     * 请求获取执行权限
     * @returns {Promise<boolean>} 是否获得权限
     */
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

    /**
     * 释放执行权限
     */
    releaseRequest() {
        if (this.requestQueue.length > 0) {
            const nextRequest = this.requestQueue.shift();
            nextRequest(true);
        } else {
            this.currentRequests--;
        }
    }
}

// ==================== Twitter 总结器核心类 ====================

/**
 * Twitter 总结器类
 * 
 * 负责：
 * - AI 客户端和数据库初始化
 * - 定时任务调度
 * - 推文数据获取和总结生成
 * - 总结结果存储
 */
class TwitterSummarizer {
    /**
     * 构造 Twitter 总结器实例
     */
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

    /**
     * 初始化AI客户端
     * @private
     */
    _initializeAIClient() {
        // 获取API密钥
        const geminiKey = process.env.GEMINI_API_KEY;

        // 检查是否有Gemini API密钥
        if (!geminiKey) {
            throw new Error("未找到GEMINI_API_KEY环境变量，请在.env文件中设置");
        }

        logger.info('使用Gemini API初始化HTTP客户端');

        // 使用axios创建HTTP客户端
        this.geminiApiKey = geminiKey;
        this.geminiBaseUrl = "https://generativelanguage.googleapis.com/v1/models";
        this.geminiModel = AI_CONFIG.model;

        logger.info(`AI客户端初始化成功，使用模型: ${this.geminiModel}`);
    }

    /**
     * 初始化数据库连接
     * @private
     */
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

    // ==================== 定时任务调度 ====================

    /**
     * 设置定时任务（使用 node-schedule）
     */
    scheduleJobs() {
        // 不再在启动时生成所有时间段的总结

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

    // ==================== 总结生成 ====================

    /**
     * 生成并保存总结（主要入口方法）
     * @param {string} period - 时间段标识
     * @returns {Promise<Object|null>} 总结对象或 null
     */
    async generateAndSaveSummary(period) {
        const canProceed = await this.throttler.acquireRequest();
        if (!canProceed) {
            logger.warn(`自动总结被拒绝：当前有其他总结正在进行中`);
            return null;
        }

        try {
            logger.info(`开始自动生成${period}总结...`);

            // 使用TimeUtil计算时间范围
            const timeRange = TimeUtil.calculateTimeRange(period);
            const queryStart = timeRange.start;
            const queryEnd = timeRange.end;

            const tweets = await this.db.getTweetsInTimeRange(queryStart, queryEnd);

            if (!tweets || tweets.length === 0) {
                logger.warn(`没有找到${period}内的推文数据，跳过总结生成`);
                await this._saveEmptySummary(period, queryStart, queryEnd);
                return null;
            }

            const summary = await this.generateSummary(period);

            // 额外确保清理内容中的代码块标记
            let cleanedSummary = summary;
            if (typeof summary === 'string') {
                // 移除开头的```html、``` 等标记
                cleanedSummary = cleanedSummary.replace(/^```(?:html)?\s*/g, '');
                // 移除结尾的``` 标记
                cleanedSummary = cleanedSummary.replace(/```\s*$/g, '');
                // 移除中间可能出现的代码块标记
                cleanedSummary = cleanedSummary.replace(/```(?:html)?|```/g, '');
            }

            const result = await this.db.saveSummary(
                period,
                cleanedSummary,
                queryStart,
                queryEnd,
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

    /**
     * 保存空数据总结到数据库
     * @param {string} period - 时间段
     * @param {Date} queryStart - 开始时间
     * @param {Date} queryEnd - 结束时间
     * @private
     */
    async _saveEmptySummary(period, queryStart, queryEnd) {
        await this.db.saveSummary(
            period,
            `<div class="no-data-message"><h3>📭 没有新数据</h3><p>在过去${period}内没有发现新的推文活动</p></div>`,
            queryStart,
            queryEnd,
            0,
            'empty'
        );
    }

    /**
     * 保存错误总结到数据库
     * @param {string} period - 时间段
     * @param {Error} error - 错误对象
     * @private
     */
    async _saveErrorSummary(period, error) {
        try {
            // 使用TimeUtil计算时间范围
            const timeRange = TimeUtil.calculateTimeRange(period);

            await this.db.saveSummary(
                period,
                `<div class="error-message"><h3>❌ 生成总结时出错</h3><p>${error.message}</p></div>`,
                timeRange.start,
                timeRange.end,
                0,
                'error'
            );
        } catch (dbError) {
            logger.error(`保存错误总结到数据库失败:`, dbError);
        }
    }

    /**
     * 获取时间段内的推文数据
     * @param {string} period - 时间段标识
     * @returns {Promise<Array>} 推文对象数组
     */
    async getPeriodData(period) {
        // 使用TimeUtil计算时间范围
        const timeRange = TimeUtil.calculateTimeRange(period);
        const queryStart = timeRange.start;
        const queryEnd = timeRange.end;

        logger.info(`开始查询${period}的推文数据 (${timeRange.startFormatted} 至 ${timeRange.endFormatted})`);
        logger.info(`时间范围: 从 ${queryStart.toLocaleString()} 到 ${queryEnd.toLocaleString()}`);

        try {
            if (!this.db) {
                logger.error('数据库未初始化，无法获取数据');
                return [];
            }

            logger.info(`正在从数据库获取时间范围内的推文...`);
            const tweets = await this.db.getTweetsInTimeRange(queryStart, queryEnd);

            this._logTweetResults(tweets, period);
            this.lastSummaryTime[period] = new Date();
            return tweets;
        } catch (error) {
            logger.error(`获取${period}数据时出错:`, error);
            return [];
        }
    }

    /**
     * 输出推文结果日志
     * @param {Array} tweets - 推文数组
     * @param {string} period - 时间段
     * @private
     */
    _logTweetResults(tweets, period) {
        if (tweets.length === 0) {
            logger.warn(`未找到指定时间范围内的推文数据 (${period})`);
        } else {
            logger.info(`获取到 ${tweets.length} 条推文，时间范围: ${period}`);
            this._logSampleTweets(tweets);
        }
    }

    /**
     * 输出示例推文日志
     * @param {Array} tweets - 推文数组
     * @private
     */
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

    /**
     * 生成 AI 总结内容
     * @param {string} period - 时间段标识
     * @returns {Promise<string>} HTML 格式的总结内容
     */
    async generateSummary(period) {
        try {
            logger.info(`开始为${period}生成总结...`);

            if (!this.db) {
                return this._getDbErrorHtml();
            }

            // 使用TimeUtil计算时间范围
            const timeRange = TimeUtil.calculateTimeRange(period);
            const queryStart = timeRange.start;
            const queryEnd = timeRange.end;

            logger.info(`生成${period}总结，时间范围: 从 ${queryStart.toLocaleString()} 到 ${queryEnd.toLocaleString()}`);
            const tweets = await this.db.getTweetsInTimeRange(queryStart, queryEnd);

            if (!tweets || tweets.length === 0) {
                return this._getNoDataHtml(period);
            }

            logger.info(`准备为${period}内的${tweets.length}条推文生成AI总结`);
            const tweetsText = this._formatTweetsForAI(tweets);
            logger.debug(`生成的推文文本长度: ${tweetsText.length} 字符`);

            // 使用北京时间范围
            const timeRangeStr = `${timeRange.beijingStart} 到 ${timeRange.beijingEnd} (北京时间)`;

            const userPrompt = `请分析以下时间范围内的Twitter推文并生成结构化市场总结：\n时间范围: ${timeRangeStr}\n\n${tweetsText}\n\n特别提醒：
1. 请直接输出HTML内容，不要使用任何代码块标记（如\`\`\`html\`\`\`）包围你的回答
2. 使用有序列表和无序列表来组织信息，不要使用表格
3. 确保HTML结构清晰，缩进合理，便于阅读
4. 对于每个项目或代币，使用<h3>标题和嵌套列表<ul><li>来组织信息`;
            logger.info('正在调用AI生成总结...');

            const content = await this._callAIWithRetry(userPrompt);
            logger.info(`AI总结生成完成，内容长度: ${content.length} 字符`);

            // 处理内容，移除可能的代码块标记
            let cleanedContent = content;
            // 移除开头的```html、``` 等标记
            cleanedContent = cleanedContent.replace(/^```(?:html)?\s*/, '');
            // 移除结尾的``` 标记
            cleanedContent = cleanedContent.replace(/```\s*$/, '');

            if (cleanedContent.length > 100000) {
                logger.warn(`生成的内容过长 (${cleanedContent.length} 字符)，可能导致传输问题`);
                return cleanedContent.substring(0, 100000) + '...[内容过长，已截断]';
            }

            return cleanedContent;
        } catch (error) {
            const errorMsg = `生成${period}总结时出错: ${error}`;
            logger.error(errorMsg);
            return this._getErrorHtml(error.message);
        }
    }

    /**
     * 格式化推文数据用于AI输入
     * @param {Array} tweets - 推文数组
     * @returns {string} 格式化后的文本
     * @private
     */
    _formatTweetsForAI(tweets) {
        const formattedTweets = tweets.map(tweet => {
            const tweetUrl = `https://x.com/${tweet.screen_name}/status/${tweet.id}`;
            return `用户: ${tweet.username} (@${tweet.screen_name})\n` +
                `发布时间: ${tweet.created_at}\n` +
                `内容: ${tweet.text}\n` +
                `交互数据: ${tweet.like_count}点赞, ${tweet.retweet_count}转发, ${tweet.reply_count}回复` +
                (tweet.media_urls ? `\n媒体: ${tweet.media_urls}` : '') +
                `\n源: ${tweetUrl}` +
                '\n' + '='.repeat(30);
        }).join('\n');

        // 在格式化文本的末尾添加提醒
        return formattedTweets + '\n\n注意：请直接输出HTML内容，不要使用代码块标记包围回答。请使用有序列表和无序列表，不要使用表格。确保HTML结构清晰，缩进合理。';
    }

    /**
     * 调用AI API并支持重试机制
     * @param {string} userPrompt - 用户提示
     * @returns {Promise<string>} AI生成的文本
     * @private
     */
    async _callAIWithRetry(userPrompt) {
        const timeoutMs = 300000; // 5分钟超时
        const maxRetries = 2;
        let lastError = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    logger.info(`AI请求重试 ${attempt}/${maxRetries}...`);
                    await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
                }

                logger.info(`使用Gemini模型发送HTTP请求...`);

                // 构建请求URL
                const url = `${this.geminiBaseUrl}/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`;

                // 构建请求体
                const requestBody = {
                    contents: [
                        { role: "user", parts: [{ text: `${SYSTEM_PROMPT}\n\n${userPrompt}` }] }
                    ],
                    generationConfig: {
                        temperature: AI_CONFIG.temperature,
                        maxOutputTokens: 4000,
                    }
                };

                // 发送请求
                const response = await axios.post(url, requestBody, {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: timeoutMs
                });

                // 检查响应
                if (!response || !response.data || !response.data.candidates || !response.data.candidates[0]) {
                    logger.error('Gemini API返回数据无效');
                    throw new Error('Gemini API返回空响应');
                }

                // 提取文本内容
                const candidate = response.data.candidates[0];
                if (!candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
                    throw new Error('响应格式不符合预期');
                }

                return candidate.content.parts[0].text;
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

    /**
     * 获取数据库错误的HTML消息
     * @returns {string} 错误消息HTML
     * @private
     */
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

    /**
     * 获取无数据的HTML消息
     * @param {string} period - 时间段
     * @returns {string} 无数据消息HTML
     * @private
     */
    _getNoDataHtml(period) {
        return `<div class="no-data-message">
            <h3>📭 没有新数据</h3>
            <p>在过去${period}内没有发现新的推文活动</p>
        </div>`;
    }

    /**
     * 获取错误的HTML消息
     * @param {string} message - 错误消息
     * @returns {string} 错误消息HTML
     * @private
     */
    _getErrorHtml(message) {
        return `<div class="error-message">
            <h3>❌ 生成总结时出错</h3>
            <p>${message}</p>
        </div>`;
    }

    /**
     * 清理资源并关闭连接
     */
    cleanup() {
        if (this.db) {
            this.db.close();
        }
    }

    /**
     * 启动服务
     * @returns {Promise<void>}
     */
    async start() {
        try {
            // 初始化所有服务
            await this._initializeServices();
        } catch (error) {
            logger.error('系统启动失败:', error);
            throw error;
        }
    }

    /**
     * 初始化服务的钩子方法（用于未来扩展）
     * @returns {Promise<boolean>}
     * @private
     */
    async _initializeServices() {
        logger.info('正在初始化服务...');
        // 所有初始化已经在构造函数中完成，这里作为未来扩展的钩子
        return true;
    }
}

// ==================== Web 服务器设置 ====================

/**
 * 创建并配置 Express Web 服务器
 * @param {TwitterSummarizer} summarizer - 总结器实例
 * @returns {express.Application} Express 应用实例
 */
function setupWebServer(summarizer) {
const app = express();
app.use(express.json());
    app.use(express.static('public'));

    _configureServer(app);
    _setupRoutes(app, summarizer);

    return app;
}

/**
 * 配置服务器中间件和目录
 * @param {express.Application} app - Express应用实例
 * @private
 */
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

/**
 * 设置API路由
 * @param {express.Application} app - Express应用实例
 * @param {TwitterSummarizer} summarizer - 总结器实例
 * @private
 */
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
        const summaryId = req.query.id; // 新增：支持通过ID查询特定报告
        const validPeriods = ['1hour', '12hours', '1day'];

        if (!validPeriods.includes(period)) {
            return res.status(400).json({ error: '无效的时间段' });
        }

        if (!summarizer || !summarizer.db) {
            return res.status(500).json({ error: 'Twitter总结器未初始化或数据库连接失败' });
        }

        try {
            logger.info(`接收到Web请求：获取${period}总结${summaryId ? ` (ID: ${summaryId})` : ''}`);

            let summary;
            if (summaryId) {
                // 如果提供了ID，获取特定的总结
                summary = await summarizer.db.getSummaryById(summaryId);
                if (!summary) {
                    return res.status(404).json({ error: `未找到ID为${summaryId}的总结记录` });
                }
            } else {
                // 否则获取最新的总结
                summary = await summarizer.db.getLatestSummary(period);
            }

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
        const page = parseInt(req.query.page || '1', 10);
        const offset = (page - 1) * limit;
        const validPeriods = ['1hour', '12hours', '1day'];

        if (!validPeriods.includes(period)) {
            return res.status(400).json({ error: '无效的时间段' });
        }

        if (!summarizer || !summarizer.db) {
            return res.status(500).json({ error: 'Twitter总结器未初始化或数据库连接失败' });
        }

        try {
            logger.info(`接收到Web请求：获取${period}总结历史 (页码: ${page}, 每页显示: ${limit}条)`);
            const history = await summarizer.db.getSummaryHistory(period, limit, offset);

            return res.json({
                period,
                count: history.length,
                page: page,
                limit: limit,
                history: history.map(item => ({
                    id: item.id,
                    created_at: item.created_at,
                    formatted_time: TimeUtil.formatToBeiJingTime(new Date(item.created_at)),
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
        const summaryId = req.query.id; // 检查是否指定了历史报告ID
        const validPeriods = ['1hour', '12hours', '1day'];

        if (!validPeriods.includes(period)) {
            return res.status(400).json({ error: '无效的时间段' });
        }

        if (!summarizer) {
            return res.status(500).json({ error: 'Twitter总结器未初始化' });
        }

        // 如果指定了报告ID，说明是尝试更新历史报告，不允许这种操作
        if (summaryId) {
            return res.status(403).json({
                error: '不允许更新历史报告',
                message: '只有最新的报告可以更新'
            });
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

/**
 * 格式化总结响应对象
 * @param {Object} summary - 总结对象
 * @returns {Object} 格式化后的响应对象
 */
function _formatSummaryResponse(summary) {
    if (!summary) {
        return {
            success: false,
            error: "未找到总结数据"
        };
    }

    // 解析开始和结束时间
    const startTime = new Date(summary.start_time);
    const endTime = new Date(summary.end_time);

    // 计算中国时区的时间 (UTC+8)
    const beijingStartTime = new Date(startTime.getTime() + 8 * 60 * 60 * 1000);
    const beijingEndTime = new Date(endTime.getTime() + 8 * 60 * 60 * 1000);

    // 格式化开始和结束的小时为两位数
    const startHour = beijingStartTime.getHours().toString().padStart(2, '0');
    const endHour = beijingEndTime.getHours().toString().padStart(2, '0');
    const timeRange = `${startHour}:00～${endHour}:00`;

    // 格式化完整的北京时间显示
    const formattedTime = beijingStartTime.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    return {
        success: true,
        id: summary.id,
        summary: summary.content,
        period: summary.period,
        start_time: summary.start_time,
        end_time: summary.end_time,
        tweet_count: summary.tweet_count,
        created_at: summary.created_at,
        formatted_time: formattedTime,
        timeRange: timeRange
    };
}

// ==================== 系统入口 ====================

/**
 * 系统主入口函数
 * 
 * 初始化并启动整个系统：
 * - 创建总结器实例
 * - 启动 Web 服务器
 * - 设置进程信号处理
 */
async function main() {
    try {
        logger.info('正在启动Twitter数据分析和总结系统...');

        // 初始化总结器和Web服务器
        const summarizer = new TwitterSummarizer();
        await summarizer.start();

        const app = setupWebServer(summarizer);

        const PORT = process.env.PORT || 5001;
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

// 如果直接运行此文件（非 require 导入），则执行主函数
if (require.main === module) {
    main();
}

// ==================== 模块导出 ====================

module.exports = {
    TwitterSummarizer,
    setupWebServer,
    TimeUtil
};
