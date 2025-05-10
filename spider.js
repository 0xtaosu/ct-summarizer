/**
 * Twitter/X 数据收集器
 * 基于KooSocial API采集指定Twitter用户的推文数据并存储到SQLite数据库
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const schedule = require('node-schedule');
const winston = require('winston');
const { DatabaseManager, CONFIG } = require('./data');

/**
 * 配置常量
 */
const SPIDER_CONFIG = {
    API_BASE_URL: 'https://api.koosocial.com',
    POLL_INTERVAL: '0 * * * *', // 每小时整点执行一次
    API_REQUEST_DELAY: 5000, // 请求间隔5秒，避免API限制
    MAX_TWEETS_PER_REQUEST: 20
};

/**
 * 配置日志记录器
 */
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'spider.log' }),
        new winston.transports.Console()
    ]
});

/**
 * Twitter数据采集器类
 */
class TwitterPoller {
    /**
     * 构造函数
     * @throws {Error} 如果环境变量中没有设置API密钥
     */
    constructor() {
        // 初始化KooSocial API客户端
        this.apiKey = process.env.KOOSOCIAL_API_KEY;
        if (!this.apiKey) {
            throw new Error("KOOSOCIAL_API_KEY not found in environment variables");
        }

        // 创建API客户端
        this.client = axios.create({
            baseURL: SPIDER_CONFIG.API_BASE_URL,
            headers: {
                'Content-Type': 'application/json',
                'X-api-key': this.apiKey
            },
            timeout: 30000 // 设置30秒超时
        });

        // 初始化数据库 (写入模式)
        this.dbManager = new DatabaseManager(false);

        // 初始化统计信息
        this.stats = {
            totalRuns: 0,
            lastRunTime: null,
            nextRunTime: null,
            totalTweetsCollected: 0,
            usersCounted: 0
        };

        logger.info('Twitter数据采集器已初始化');
    }

    /**
     * 通过用户名获取Twitter用户信息
     * @param {string} username - 要获取信息的用户名
     * @returns {Promise<Object|null>} 包含用户ID、名称和屏幕名称的对象，失败时返回null
     */
    async getUserByUsername(username) {
        try {
            logger.info(`正在获取用户 ${username} 的信息...`);

            const userResponse = await this.client.get(`/api/v1/user`, {
                params: { username }
            });

            // 验证响应数据结构
            if (!userResponse.data?.result?.data?.user?.result) {
                logger.error(`找不到用户 ${username}，API返回数据格式不符合预期`);
                return null;
            }

            const userData = userResponse.data.result.data.user.result;

            // 提取需要的用户信息
            const userInfo = {
                id: userData.rest_id,
                username: userData.legacy.name,
                screen_name: userData.legacy.screen_name
            };

            logger.info(`成功获取用户信息: ${userInfo.username} (@${userInfo.screen_name}), ID: ${userInfo.id}`);
            return userInfo;
        } catch (error) {
            this.logApiError(error, `获取用户 ${username} 信息时出错`);
            return null;
        }
    }

    /**
     * 获取指定用户的推文
     * @param {string} userId - 用户ID
     * @param {string} username - 用户名称
     * @param {string} screen_name - 用户屏幕名称
     * @returns {Promise<Array>} 推文对象数组，失败时返回空数组
     */
    async getUserTweets(userId, username, screen_name) {
        try {
            logger.info(`正在获取用户 ${username} (ID: ${userId}) 的推文...`);

            const tweetsResponse = await this.client.get(`/api/v1/user-tweets`, {
                params: {
                    user: userId,
                    count: SPIDER_CONFIG.MAX_TWEETS_PER_REQUEST
                }
            });

            // 验证响应数据结构
            if (!tweetsResponse.data?.result?.timeline?.instructions) {
                logger.error(`无法获取用户 ${username} 的推文，API返回数据格式不符合预期`);
                return [];
            }

            // 寻找TimelineAddEntries指令
            const addEntriesInstruction = tweetsResponse.data.result.timeline.instructions.find(
                instruction => instruction.type === 'TimelineAddEntries'
            );

            if (!addEntriesInstruction?.entries) {
                logger.error(`用户 ${username} 的推文数据结构不符合预期，找不到TimelineAddEntries指令或entries`);
                return [];
            }

            const processedTweets = [];

            // 处理每个推文
            for (const entry of addEntriesInstruction.entries) {
                const tweet = this.extractTweetFromEntry(entry);
                if (tweet) {
                    processedTweets.push({
                        ...tweet,
                        user_id: userId,
                        username: username,
                        screen_name: screen_name
                    });
                }
            }

            logger.info(`成功获取到 ${processedTweets.length} 条 ${username} 的推文`);
            return processedTweets;
        } catch (error) {
            this.logApiError(error, `获取用户 ${username} 推文时出错`);
            return [];
        }
    }

    /**
     * 从TimelineEntry中提取推文数据
     * @param {Object} entry - Timeline条目对象
     * @returns {Object|null} 提取的推文数据，无效条目返回null
     * @private
     */
    extractTweetFromEntry(entry) {
        // 验证条目结构
        if (!entry.content?.entryType || entry.content.entryType !== 'TimelineTimelineItem') {
            return null;
        }

        if (!entry.content.itemContent?.itemType || entry.content.itemContent.itemType !== 'TimelineTweet') {
            return null;
        }

        const tweetResults = entry.content.itemContent.tweet_results;
        if (!tweetResults?.result) {
            return null;
        }

        const tweet = tweetResults.result;

        // 确保legacy属性存在
        if (!tweet.legacy) {
            logger.error(`推文 ${tweet.rest_id || 'unknown'} 缺少legacy属性`);
            return null;
        }

        // 提取媒体URL (如果有)
        let mediaUrls = [];
        if (tweet.legacy.extended_entities?.media) {
            mediaUrls = tweet.legacy.extended_entities.media.map(media => media.media_url_https);
        }

        // 返回规范化的推文数据
        return {
            id: tweet.rest_id,
            text: tweet.legacy.full_text,
            created_at: tweet.legacy.created_at,
            retweet_count: tweet.legacy.retweet_count,
            like_count: tweet.legacy.favorite_count,
            reply_count: tweet.legacy.reply_count,
            quote_count: tweet.legacy.quote_count,
            bookmark_count: tweet.legacy.bookmark_count,
            view_count: tweet.views ? tweet.views.count : 0,
            media_urls: mediaUrls.join(',')
        };
    }

    /**
     * 获取并保存指定用户的推文
     * @param {string} username - 用户名
     * @returns {Promise<number>} 获取到的推文数量
     */
    async pollUserTweets(username) {
        try {
            // 获取用户信息
            const user = await this.getUserByUsername(username);
            if (!user) {
                logger.error(`无法获取用户 ${username} 的信息`);
                return 0;
            }

            // 获取用户推文
            const tweets = await this.getUserTweets(user.id, user.username, user.screen_name);

            if (tweets.length === 0) {
                logger.info(`用户 ${username} 没有获取到新推文`);
                return 0;
            }

            // 保存推文到数据库
            const saveStats = await this.dbManager.saveTweetsToDatabase(tweets);

            logger.info(`成功完成用户 ${username} 的推文数据获取和保存: 新增 ${saveStats.new}, 更新 ${saveStats.updated}, 跳过 ${saveStats.skipped}`);
            return tweets.length;
        } catch (error) {
            logger.error(`获取用户 ${username} 的推文时出错: ${error.message}`);
            return 0;
        }
    }

    /**
     * 获取所有配置的用户推文
     * @returns {Promise<Object>} 统计信息
     */
    async pollAllUsers() {
        const runStats = {
            startTime: new Date(),
            endTime: null,
            totalTweets: 0,
            usersProcessed: 0,
            errors: 0
        };

        try {
            // 从CSV文件读取用户列表
            const usernames = this.dbManager.loadUsersFromCsv();
            if (usernames.size === 0) {
                logger.warn('没有找到需要获取数据的用户');
                runStats.endTime = new Date();
                return runStats;
            }

            logger.info(`找到 ${usernames.size} 个用户需要获取数据`);

            // 轮询每个用户的推文
            for (const username of usernames) {
                try {
                    const tweetCount = await this.pollUserTweets(username);
                    runStats.totalTweets += tweetCount;
                    runStats.usersProcessed++;
                } catch (userError) {
                    logger.error(`处理用户 ${username} 时出错: ${userError.message}`);
                    runStats.errors++;
                }

                // 添加间隔以避免API限制
                await this.sleep(SPIDER_CONFIG.API_REQUEST_DELAY);
            }

            runStats.endTime = new Date();
            const duration = (runStats.endTime.getTime() - runStats.startTime.getTime()) / 1000;

            logger.info(`=== 数据采集完成 ===`);
            logger.info(`开始时间: ${runStats.startTime.toISOString()}`);
            logger.info(`结束时间: ${runStats.endTime.toISOString()}`);
            logger.info(`总用时: ${duration.toFixed(2)}秒`);
            logger.info(`处理用户: ${runStats.usersProcessed}/${usernames.size}`);
            logger.info(`获取推文: ${runStats.totalTweets}条`);
            logger.info(`错误数量: ${runStats.errors}`);

            // 更新全局统计信息
            this.updateStats(runStats);

            return runStats;
        } catch (error) {
            logger.error(`获取所有用户数据时出错: ${error.message}`);
            runStats.endTime = new Date();
            runStats.errors++;
            return runStats;
        }
    }

    /**
     * 更新统计信息
     * @param {Object} runStats - 单次运行的统计信息
     * @private
     */
    updateStats(runStats) {
        this.stats.totalRuns++;
        this.stats.lastRunTime = runStats.endTime;
        this.stats.totalTweetsCollected += runStats.totalTweets;
        this.stats.usersCounted += runStats.usersProcessed;

        // 计算下次运行时间 (下一个整点)
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(now.getHours() + 1);
        nextHour.setMinutes(0);
        nextHour.setSeconds(0);
        nextHour.setMilliseconds(0);

        this.stats.nextRunTime = nextHour;

        logger.info(`下次数据采集将在 ${nextHour.toLocaleString()} 开始`);
    }

    /**
     * 启动定时轮询服务
     */
    startPolling() {
        // 立即执行一次数据采集
        logger.info('服务启动，立即执行首次数据采集...');
        this.pollAllUsers().then(() => {
            logger.info('首次数据采集完成，已设置定时任务');
        }).catch(error => {
            logger.error(`首次数据采集失败: ${error.message}`);
        });

        // 配置定时任务 - 每小时整点执行
        const job = schedule.scheduleJob(SPIDER_CONFIG.POLL_INTERVAL, async () => {
            const now = new Date();
            logger.info(`=== 开始定时数据采集 (${now.toLocaleString()}) ===`);
            await this.pollAllUsers();
        });

        if (job) {
            logger.info(`爬虫服务已启动，将按照计划 "${SPIDER_CONFIG.POLL_INTERVAL}" 执行 (每小时整点)`);

            // 计算下次执行时间
            const nextRun = job.nextInvocation();
            logger.info(`下次执行时间: ${nextRun.toLocaleString()}`);
        } else {
            logger.error('爬虫服务启动失败，无法创建计划任务');
        }
    }

    /**
     * 测试方法：立即执行一次数据获取
     * @returns {Promise<Object>} 运行统计信息
     */
    async test() {
        logger.info('=== 开始测试数据获取 ===');
        const stats = await this.pollAllUsers();
        logger.info('=== 测试运行完成 ===');
        return stats;
    }

    /**
     * 记录API错误详情
     * @param {Error} error - 错误对象
     * @param {string} message - 错误消息前缀
     * @private
     */
    logApiError(error, message) {
        logger.error(`${message}: ${error.message}`);

        if (error.response) {
            // 服务器返回了错误响应
            logger.error(`API错误响应: ${JSON.stringify({
                status: error.response.status,
                statusText: error.response.statusText,
                data: error.response.data
            })}`);
        } else if (error.request) {
            // 请求已发送但没有收到响应
            logger.error(`API请求错误: 未收到响应`);
        } else {
            // 请求设置时发生错误
            logger.error(`API配置错误: ${error.message}`);
        }
    }

    /**
     * 辅助方法：延迟执行
     * @param {number} ms - 毫秒数
     * @returns {Promise<void>}
     * @private
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 关闭数据库连接
     */
    close() {
        if (this.dbManager) {
            this.dbManager.close();
            logger.info('数据库连接已关闭');
        }
    }

    /**
     * 获取采集器统计信息
     * @returns {Object} 统计信息对象
     */
    getStats() {
        return {
            ...this.stats,
            currentTime: new Date()
        };
    }
}

/**
 * 主函数：初始化并启动服务
 */
function main() {
    try {
        // 启动服务
        const poller = new TwitterPoller();

        // 处理程序退出
        process.on('SIGINT', () => {
            logger.info('接收到中断信号，正在关闭...');
            poller.close();
            process.exit(0);
        });

        // 检查是否以测试模式运行
        if (process.argv.includes('--test')) {
            poller.test().then((stats) => {
                logger.info(`测试统计: 处理用户 ${stats.usersProcessed} 个，获取推文 ${stats.totalTweets} 条，用时 ${((stats.endTime - stats.startTime) / 1000).toFixed(2)} 秒`);
                poller.close();
                process.exit(0);
            }).catch(error => {
                logger.error(`测试失败: ${error.message}`);
                poller.close();
                process.exit(1);
            });
        } else {
            logger.info(`=== Twitter 数据采集服务启动 ===`);
            logger.info(`时间: ${new Date().toLocaleString()}`);
            logger.info(`计划: 每小时整点自动获取数据`);
            poller.startPolling();
        }
    } catch (error) {
        logger.error(`启动服务时出错: ${error.message}`);
        process.exit(1);
    }
}

// 执行主函数
main(); 