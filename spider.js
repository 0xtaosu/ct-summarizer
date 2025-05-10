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
    POLL_INTERVAL: '0 * * * *', // 每小时执行一次
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
     * @returns {Promise<void>}
     */
    async pollUserTweets(username) {
        try {
            // 获取用户信息
            const user = await this.getUserByUsername(username);
            if (!user) {
                logger.error(`无法获取用户 ${username} 的信息`);
                return;
            }

            // 获取用户推文
            const tweets = await this.getUserTweets(user.id, user.username, user.screen_name);

            // 保存推文到数据库
            await this.dbManager.saveTweetsToDatabase(tweets);

            logger.info(`成功完成用户 ${username} 的推文数据获取和保存`);
        } catch (error) {
            logger.error(`获取用户 ${username} 的推文时出错: ${error.message}`);
        }
    }

    /**
     * 获取所有配置的用户推文
     * @returns {Promise<void>}
     */
    async pollAllUsers() {
        try {
            // 从CSV文件读取用户列表
            const usernames = this.dbManager.loadUsersFromCsv();
            if (usernames.size === 0) {
                logger.warn('没有找到需要获取数据的用户');
                return;
            }

            logger.info(`找到 ${usernames.size} 个用户需要获取数据`);

            // 轮询每个用户的推文
            for (const username of usernames) {
                await this.pollUserTweets(username);
                // 添加间隔以避免API限制
                await this.sleep(SPIDER_CONFIG.API_REQUEST_DELAY);
            }
        } catch (error) {
            logger.error(`获取所有用户数据时出错: ${error.message}`);
        }
    }

    /**
     * 启动定时轮询服务
     */
    startPolling() {
        // 配置定时任务
        const job = schedule.scheduleJob(SPIDER_CONFIG.POLL_INTERVAL, async () => {
            logger.info('开始定时获取数据...');
            await this.pollAllUsers();
        });

        if (job) {
            logger.info(`爬虫服务已启动，将按照计划 "${SPIDER_CONFIG.POLL_INTERVAL}" 执行`);
        } else {
            logger.error('爬虫服务启动失败，无法创建计划任务');
        }
    }

    /**
     * 测试方法：立即执行一次数据获取
     * @returns {Promise<void>}
     */
    async test() {
        logger.info('开始测试数据获取...');
        await this.pollAllUsers();
        logger.info('测试完成');
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
            poller.test().then(() => {
                poller.close();
                process.exit(0);
            }).catch(error => {
                logger.error(`测试失败: ${error.message}`);
                poller.close();
                process.exit(1);
            });
        } else {
            poller.startPolling();
        }
    } catch (error) {
        logger.error(`启动服务时出错: ${error.message}`);
        process.exit(1);
    }
}

// 执行主函数
main(); 