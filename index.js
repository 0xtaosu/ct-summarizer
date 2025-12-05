/**
 * Twitter 数据分析和总结系统
 * 
 * 核心功能：
 * - 定时从 SQLite 数据库读取 Twitter 推文数据
 * - 使用 xAI Grok 模型生成智能分析总结
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
const schedule = require('node-schedule');
const OpenAI = require('openai');
const TelegramBot = require('node-telegram-bot-api');

const { createLogger } = require('./logger');
const { DatabaseManager } = require('./data');
const { SYSTEM_PROMPT, AI_CONFIG, CRON_SCHEDULES } = require('./config');

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
        return date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZone: 'Asia/Shanghai'
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

        // 格式化北京时间，确保小时值使用两位数字
        const beijingStartHour = queryStart.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
        const beijingEndHour = queryEnd.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
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
        this._initializeTelegramBot();
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
        const xaiKey = process.env.XAI_API_KEY;

        if (!xaiKey) {
            throw new Error("未找到 XAI_API_KEY 环境变量，请在 .env 文件中设置");
        }

        logger.info('使用 xAI 客户端初始化...');

        this.xaiModel = AI_CONFIG.model;
        this.xaiClient = new OpenAI({
            apiKey: xaiKey,
            baseURL: 'https://api.x.ai/v1',
            timeout: 360000
        });

        logger.info(`AI客户端初始化成功，使用模型: ${this.xaiModel}`);
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

    /**
     * 初始化 Telegram Bot（可选）
     * @private
     */
    _initializeTelegramBot() {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;

        if (token && chatId) {
            this.telegramBot = new TelegramBot(token, { polling: false });
            this.telegramChatId = chatId;
            logger.info('Telegram Bot 已初始化，将在生成总结后推送');
        } else {
            logger.warn('未配置 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，跳过 Telegram 推送');
            this.telegramBot = null;
            this.telegramChatId = null;
        }
    }

    // ==================== 定时任务调度 ====================

    /**
     * 设置定时任务（使用 node-schedule）
     */
    scheduleJobs() {
        // 每小时在x:10分时生成1小时总结（例如1:10, 2:10, 3:10...）
        schedule.scheduleJob(CRON_SCHEDULES.SUMMARY_1HOUR, async () => {
            logger.info('执行定时任务: 生成1小时总结');
            await this.generateAndSaveSummary('1hour', { trigger: 'cron' });
        });



        logger.info('已设置定时总结任务');
    }

    // ==================== 总结生成 ====================

    /**
     * 生成并保存总结（主要入口方法）
     * @param {string} period - 时间段标识
     * @returns {Promise<Object|null>} 总结对象或 null
     */
    async generateAndSaveSummary(period, options = {}) {
        const canProceed = await this.throttler.acquireRequest();
        if (!canProceed) {
            logger.warn(`自动总结被拒绝：当前有其他总结正在进行中`);
            return null;
        }

        const trigger = options.trigger || 'auto';

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

            // 推送到 Telegram（若已配置）
            try {
                await this._sendTelegramSummary(period, timeRange.beijingTimeRange, cleanedSummary, tweets.length, trigger);
            } catch (tgErr) {
                logger.warn(`Telegram 推送失败: ${tgErr.message}`);
            }

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
     * 将HTML总结格式化为适合Telegram的文本（保留链接，去除列表标签）
     * @param {string} content
     * @returns {string}
     * @private
     */
    _formatSummaryForTelegram(content) {
        if (!content || typeof content !== 'string') return '';

        let text = content;

        // 去掉代码块和样式脚本
        text = text.replace(/```[\s\S]*?```/g, '');
        text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
        text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

        // 将列表转换为简单行文本
        text = text.replace(/<ol[^>]*>/gi, '');
        text = text.replace(/<\/ol>/gi, '');
        text = text.replace(/<li[^>]*>/gi, '\n• ');
        text = text.replace(/<\/li>/gi, '');

        // 保留链接但去掉无用换行
        text = text.replace(/<br\s*\/?>/gi, '\n');

        // 其他标签简单移除
        text = text.replace(/<\/?(div|span|p)>/gi, '\n');
        text = text.replace(/&nbsp;/g, ' ');

        return text.trim();
    }

    /**
     * 将总结推送到Telegram
     * @param {string} period
     * @param {string} timeRange
     * @param {string} summaryHtml
     * @param {number} tweetCount
     * @param {string} trigger - 来源标记（startup/cron/manual/auto）
     * @private
     */
    async _sendTelegramSummary(period, timeRange, summaryHtml, tweetCount, trigger = 'auto') {
        if (!this.telegramBot || !this.telegramChatId) return;
        // 仅推送1小时总结
        if (period !== '1hour') return;

        const triggerLabelMap = {
            startup: '启动',
            cron: '定时',
            manual: '手动',
            auto: '自动'
        };
        const label = triggerLabelMap[trigger] || trigger;

        const header = `<b>1小时总结</b> (${timeRange} 北京时间, ${label})\n数据量: ${tweetCount || 0} 条`;
        const body = this._formatSummaryForTelegram(summaryHtml);
        let message = `${header}\n${body}`;

        // Telegram消息长度上限约4096字符，预留余量
        if (message.length > 3900) {
            message = message.slice(0, 3900) + '\n...（内容过长已截断）';
        }

        await this.telegramBot.sendMessage(this.telegramChatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: false
        });
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

            const userPrompt = `请扮演“总结大师”，用HTML生成10条中文要点，方便嵌入网页/Tg：
- 使用<ol><li>…</li></ol>有序列表；不要输出代码块或表格
- 聚焦事件/结论，突出数字/影响/动作，避免客套
- 优先写发射/空投/IDO等信号（规则、时间、参与方式），再写合作/技术/市场动向
- 如有来源链接，在该条末尾追加 <a href="链接" target="_blank">[01]</a>，多来源累加 [02][03]…

时间范围: ${timeRangeStr}

以下是推文片段：
${tweetsText}`;
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

        return formattedTweets;
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

                logger.info(`使用 xAI Grok 模型发送HTTP请求...`);

                const response = await this.xaiClient.chat.completions.create({
                    model: this.xaiModel,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: AI_CONFIG.temperature
                });

                const text = response?.choices?.[0]?.message?.content;
                if (!text) {
                    throw new Error('xAI API返回空响应');
                }

                return text;
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

            // 启动时生成一次1小时总结并推送
            try {
                await this.generateAndSaveSummary('1hour', { trigger: 'startup' });
            } catch (err) {
                logger.warn(`启动时生成1小时总结失败: ${err.message}`);
            }
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
            const result = await summarizer.generateAndSaveSummary(period, { trigger: 'manual' });

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

    // 格式化开始和结束的小时为两位数
    const startHour = startTime.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
    const endHour = endTime.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
    const timeRange = `${startHour}:00～${endHour}:00`;

    // 格式化完整的北京时间显示
    const formattedTime = startTime.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Asia/Shanghai'
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
 * 尝试监听端口，若被占用则依次递增尝试
 * @param {express.Application} app
 * @param {number} startPort
 * @param {number} maxRetries
 * @returns {Promise<{server: import('http').Server, port: number}>}
 */
function startServerWithFallback(app, startPort, maxRetries = 5) {
    return new Promise((resolve, reject) => {
        let port = startPort;
        let attempts = 0;

        const tryListen = () => {
            const server = app.listen(port, () => resolve({ server, port }));
            server.on('error', (err) => {
                if (err.code === 'EADDRINUSE' && attempts < maxRetries) {
                    logger.warn(`端口 ${port} 已被占用，尝试端口 ${port + 1}...`);
                    port += 1;
                    attempts += 1;
                    setTimeout(tryListen, 100);
                } else {
                    reject(err);
                }
            });
        };

        tryListen();
    });
}

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

        const desiredPort = Number(process.env.PORT) || 5001;
        const { server, port: usedPort } = await startServerWithFallback(app, desiredPort);
        logger.info(`服务器运行在端口 ${usedPort}`);
        logger.info(`访问 http://localhost:${usedPort} 以使用Web界面`);

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
