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
    API_REQUEST_DELAY: 100, // 请求间隔50毫秒，每秒最多20次请求
    MAX_CONCURRENT_REQUESTS: 10, // 最大并发请求数
    MAX_TWEETS_PER_REQUEST: 100, // 每次请求最多获取20条推文
    FOLLOWER_SOURCE_ACCOUNT: process.env.FOLLOWER_SOURCE_ACCOUNT, // 从env读取关注列表源账号
    MAX_FOLLOWINGS_PER_REQUEST: 70 // API最大支持70个用户每次请求
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
            usersCounted: 0,
            lastFollowerUpdate: null,
            totalFollowersTracked: 0
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
            let validEntries = 0;
            let nonTweetEntries = 0;

            // 处理每个推文
            for (const entry of addEntriesInstruction.entries) {
                const tweet = this.extractTweetFromEntry(entry);
                if (tweet) {
                    validEntries++;
                    processedTweets.push({
                        ...tweet,
                        user_id: userId,
                        username: username,
                        screen_name: screen_name
                    });
                } else {
                    // 统计非推文条目
                    nonTweetEntries++;
                }
            }

            // 详细日志记录处理结果
            const totalEntries = addEntriesInstruction.entries.length;
            logger.info(`成功获取到 ${processedTweets.length} 条 ${username} 的推文 (API返回条目总数: ${totalEntries}, 有效推文: ${validEntries}, 非推文条目: ${nonTweetEntries})`);

            // 如果没有获取到足够的推文，显示警告
            if (processedTweets.length < SPIDER_CONFIG.MAX_TWEETS_PER_REQUEST && processedTweets.length > 0) {
                logger.warn(`获取的推文数量 (${processedTweets.length}) 少于请求的数量 (${SPIDER_CONFIG.MAX_TWEETS_PER_REQUEST})，可能是用户推文较少或API限制`);
            }

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
     * 获取用户的关注列表（用户关注的人）
     * @param {string} username - 目标用户名
     * @param {string} cursor - 分页游标
     * @returns {Promise<Object>} 包含关注列表和下一页游标的对象
     */
    async getUserFollowings(username, cursor = null) {
        try {
            logger.info(`正在获取用户 ${username} 的关注列表${cursor ? ' (使用游标: ' + cursor + ')' : ''}...`);

            // 首先获取用户信息以获取user_id
            let userId = null;

            // 如果提供的是数字ID而不是用户名，直接使用
            if (/^\d+$/.test(username)) {
                userId = username;
                logger.info(`使用提供的用户ID: ${userId}`);
            } else {
                // 否则获取用户信息来获取ID
                const user = await this.getUserByUsername(username);
                if (!user) {
                    logger.error(`无法获取用户 ${username} 的信息`);
                    return { followings: [], nextCursor: null };
                }
                userId = user.id;
            }

            // 构建请求参数
            const params = {
                user: userId,
                count: SPIDER_CONFIG.MAX_FOLLOWINGS_PER_REQUEST
            };

            // 如果提供了游标，添加到请求中
            if (cursor) {
                params.cursor = cursor;
            }

            logger.info(`API请求参数: ${JSON.stringify(params)}`);
            const followingsResponse = await this.client.get(`/api/v1/followings`, { params });

            // 检查顶层的cursor对象
            if (followingsResponse.data?.cursor) {
                logger.info(`API响应中找到顶层cursor对象: ${JSON.stringify(followingsResponse.data.cursor)}`);
            }

            // 验证响应数据结构
            if (!followingsResponse.data?.result?.timeline?.instructions) {
                logger.error(`无法获取用户 ${username} 的关注列表，API返回数据格式不符合预期`);
                logger.error(`API响应: ${JSON.stringify(followingsResponse.data)}`);
                return { followings: [], nextCursor: null };
            }

            const followings = [];
            // 设置下一页游标 - 优先从顶层的cursor对象中获取
            let nextCursor = null;

            if (followingsResponse.data.cursor && followingsResponse.data.cursor.bottom) {
                const bottomCursor = followingsResponse.data.cursor.bottom;
                logger.info(`从顶层cursor对象中找到底部游标: ${bottomCursor}`);

                // 解析游标值 - 如果以"0|"开头表示最后一页
                const cursorParts = bottomCursor.split('|');
                if (cursorParts.length > 1 && cursorParts[0] === '0') {
                    logger.info(`底部游标 "${bottomCursor}" 以"0|"开头，表示没有更多页面`);
                    nextCursor = null;
                } else {
                    nextCursor = bottomCursor;
                    logger.info(`使用底部游标作为下一页游标: ${nextCursor}`);
                }
            } else {
                logger.info(`API响应中没有找到顶层cursor对象或bottom游标`);
            }

            // 提取关注列表信息
            // 寻找TimelineAddEntries指令
            const addEntriesInstruction = followingsResponse.data.result.timeline.instructions.find(
                instruction => instruction.type === 'TimelineAddEntries'
            );

            if (addEntriesInstruction && addEntriesInstruction.entries) {
                // 处理每个条目
                for (const entry of addEntriesInstruction.entries) {
                    // 跳过游标条目
                    if (entry.entryId && entry.entryId.startsWith('cursor-')) {
                        continue;
                    }

                    // 提取用户信息
                    const following = this.extractUserFromFollowingEntry(entry);
                    if (following) {
                        followings.push(following);
                    }
                }
            }

            logger.info(`成功获取到 ${followings.length} 个 ${username} 正在关注的用户, 下一页游标: ${nextCursor || '无'}`);
            return { followings, nextCursor };
        } catch (error) {
            this.logApiError(error, `获取用户 ${username} 关注列表时出错`);
            return { followings: [], nextCursor: null };
        }
    }

    /**
     * 从关注列表条目中提取用户信息
     * @param {Object} entry - 关注列表条目对象
     * @returns {Object|null} 提取的用户数据，无效条目返回null
     * @private
     */
    extractUserFromFollowingEntry(entry) {
        if (!entry.content || !entry.content.itemContent || entry.content.itemContent.itemType !== 'TimelineUser') {
            return null;
        }

        const userResults = entry.content.itemContent.user_results;
        if (!userResults || !userResults.result) {
            return null;
        }

        const user = userResults.result;

        // 确保legacy属性存在
        if (!user.legacy) {
            logger.error(`用户 ${user.rest_id || 'unknown'} 缺少legacy属性`);
            return null;
        }

        // 返回规范化的用户数据
        return {
            id: user.rest_id,
            username: user.legacy.name,
            screen_name: user.legacy.screen_name,
            name: user.legacy.name,
            description: user.legacy.description,
            followers_count: user.legacy.followers_count,
            following_count: user.legacy.friends_count,
            tweet_count: user.legacy.statuses_count,
            profile_image_url: user.legacy.profile_image_url_https,
            is_following: false, // 这不是关注者，而是被关注的用户
            is_tracked: true // 默认跟踪从关注列表添加的用户
        };
    }

    /**
     * 获取并存储指定用户关注的所有用户
     * @param {string} username - 目标用户名
     * @param {string} startCursor - 起始游标
     * @returns {Promise<Object>} 统计信息
     */
    async fetchAndStoreAllFollowings(username, startCursor = null) {
        const stats = {
            startTime: new Date(),
            endTime: null,
            totalFollowings: 0,
            newFollowings: 0,
            updatedFollowings: 0,
            errors: 0,
            pagesProcessed: 0,
            emptyPages: 0
        };

        try {
            logger.info(`开始获取用户 ${username} 的关注列表...`);
            logger.info(`使用最大每页数量: ${SPIDER_CONFIG.MAX_FOLLOWINGS_PER_REQUEST}`);

            let nextCursor = startCursor;
            let hasMorePages = true;
            let pageNumber = 1;
            let lastPageSize = 0;
            let emptyPageCount = 0;
            let sameCursorCount = 0;
            let lastCursor = null;
            const MAX_EMPTY_PAGES = 3; // 允许最多连续3个空页后终止
            const MAX_SAME_CURSOR = 2; // 允许最多重复同一游标2次
            const MAX_PAGES = 20; // 最大页数限制，防止无限循环

            // 预处理：创建一个批量存储用户信息的队列
            const userQueue = [];
            const saveUserBatch = async (users, isLastBatch = false) => {
                if (users.length === 0 && !isLastBatch) return;

                // 每批次最多处理50个用户
                const batchSize = 50;
                const batches = [];

                // 如果是最后一批，强制执行
                if (isLastBatch && userQueue.length > 0) {
                    users = [...userQueue];
                    userQueue.length = 0; // 清空队列
                }

                // 分批处理
                for (let i = 0; i < users.length; i += batchSize) {
                    batches.push(users.slice(i, i + batchSize));
                }

                for (const batch of batches) {
                    const promises = batch.map(following => this.dbManager.saveUser(following));
                    const results = await Promise.all(promises);

                    // 更新统计信息
                    for (const result of results) {
                        if (result.inserted) {
                            stats.newFollowings++;
                        } else if (result.updated) {
                            stats.updatedFollowings++;
                        }
                        stats.totalFollowings++;
                    }
                }
            };

            // 循环获取所有页的关注
            while (hasMorePages && pageNumber <= MAX_PAGES) {
                logger.info(`正在获取第 ${pageNumber} 页关注列表数据${nextCursor ? ' (游标: ' + nextCursor + ')' : ''}...`);

                // 检查游标是否重复
                if (nextCursor && nextCursor === lastCursor) {
                    sameCursorCount++;
                    logger.warn(`警告: 收到相同的游标 ${sameCursorCount} 次`);

                    if (sameCursorCount >= MAX_SAME_CURSOR) {
                        logger.warn(`已重复接收相同游标 ${MAX_SAME_CURSOR} 次，终止分页请求以避免无限循环`);
                        hasMorePages = false;
                        break;
                    }
                } else {
                    sameCursorCount = 0;
                    lastCursor = nextCursor;
                }

                // 获取一页关注列表
                const result = await this.getUserFollowings(username, nextCursor);
                const followings = result.followings;
                const newCursor = result.nextCursor;

                stats.pagesProcessed++;
                lastPageSize = followings.length;

                if (followings.length === 0) {
                    emptyPageCount++;
                    stats.emptyPages++;
                    logger.warn(`第 ${pageNumber} 页未获取到关注用户 (连续空页: ${emptyPageCount}/${MAX_EMPTY_PAGES})`);

                    if (emptyPageCount >= MAX_EMPTY_PAGES) {
                        logger.warn(`已连续 ${MAX_EMPTY_PAGES} 页未获取到数据，终止分页请求`);
                        hasMorePages = false;
                        break;
                    }

                    // 即使是空页，如果有游标也继续尝试
                    if (!newCursor) {
                        logger.info(`无更多分页数据（无游标），停止分页请求`);
                        hasMorePages = false;
                        break;
                    } else {
                        // 有游标但页面为空，继续尝试下一页
                        nextCursor = newCursor;
                        pageNumber++;
                        await this.sleep(SPIDER_CONFIG.API_REQUEST_DELAY);
                        continue;
                    }
                } else {
                    // 重置空页计数器
                    emptyPageCount = 0;
                }

                logger.info(`第 ${pageNumber} 页获取到 ${followings.length} 个关注用户`);

                // 将用户添加到队列
                userQueue.push(...followings);

                // 当队列达到一定大小时批量保存
                if (userQueue.length >= 100) {
                    logger.info(`队列中有 ${userQueue.length} 个用户，开始批量保存...`);
                    const usersToSave = [...userQueue];
                    userQueue.length = 0; // 清空队列
                    await saveUserBatch(usersToSave);
                }

                // 更新游标
                nextCursor = newCursor;
                if (!nextCursor) {
                    logger.info(`无更多分页数据（无游标或游标格式表示已到末页），已获取所有关注用户`);
                    hasMorePages = false;
                } else {
                    logger.info(`已加载 ${stats.totalFollowings} 个关注用户，将继续获取第 ${pageNumber + 1} 页...`);
                    // 添加较短延迟以避免API限制但不过度降低速度
                    pageNumber++;
                    await this.sleep(SPIDER_CONFIG.API_REQUEST_DELAY);
                }

                // 检查是否已经达到最大页数限制
                if (pageNumber > MAX_PAGES) {
                    logger.warn(`已达到最大页数限制 (${MAX_PAGES})，停止分页请求`);
                    hasMorePages = false;
                }
            }

            // 处理队列中剩余的用户
            await saveUserBatch([], true);

            stats.endTime = new Date();
            const duration = (stats.endTime.getTime() - stats.startTime.getTime()) / 1000;

            logger.info(`=== 关注列表获取完成 ===`);
            logger.info(`开始时间: ${stats.startTime.toISOString()}`);
            logger.info(`结束时间: ${stats.endTime.toISOString()}`);
            logger.info(`总用时: ${duration.toFixed(2)}秒`);
            logger.info(`总页数: ${stats.pagesProcessed}页`);
            logger.info(`空页数: ${stats.emptyPages}页`);
            logger.info(`最后一页数量: ${lastPageSize}个`);
            logger.info(`总关注用户: ${stats.totalFollowings}个`);
            logger.info(`新增关注用户: ${stats.newFollowings}个`);
            logger.info(`更新关注用户: ${stats.updatedFollowings}个`);
            logger.info(`错误数量: ${stats.errors}`);
            logger.info(`处理速度: ${stats.totalFollowings > 0 ? (stats.totalFollowings / duration).toFixed(2) : 0} 用户/秒`);

            // 更新统计信息
            this.stats.lastFollowerUpdate = stats.endTime;
            this.stats.totalFollowersTracked = stats.totalFollowings;

            return stats;
        } catch (error) {
            logger.error(`获取关注列表时出错: ${error.message}`);
            stats.endTime = new Date();
            stats.errors++;
            return stats;
        }
    }

    /**
     * 获取并保存指定用户的推文
     * @param {string|Object} user - 用户ID或数据库用户对象
     * @returns {Promise<number>} 获取到的推文数量
     */
    async pollUserTweets(user) {
        try {
            let userId, username, screen_name;

            // 检查传入的是用户ID字符串还是用户对象
            if (typeof user === 'string') {
                // 传入的是用户ID或用户名，获取用户信息
                const userInfo = await this.getUserByUsername(user);
                if (!userInfo) {
                    logger.error(`无法获取用户 ${user} 的信息`);
                    return 0;
                }
                userId = userInfo.id;
                username = userInfo.username;
                screen_name = userInfo.screen_name;
            } else if (typeof user === 'object' && user.id) {
                // 传入的是数据库用户对象
                userId = user.id;
                username = user.username || user.name;
                screen_name = user.screen_name;
            } else {
                logger.error(`无效的用户参数: ${JSON.stringify(user)}`);
                return 0;
            }

            // 获取用户推文
            const tweets = await this.getUserTweets(userId, username, screen_name);

            if (tweets.length === 0) {
                logger.info(`用户 ${screen_name} 没有获取到新推文`);
                return 0;
            }

            // 保存推文到数据库 - 使用Promise.all优化写入
            const savePromise = this.dbManager.saveTweetsToDatabase(tweets);

            // 不必等待数据库写入完成，直接获取下一个用户的推文，数据库操作会在后台完成
            // 记录日志，但不阻塞执行流程
            savePromise.then(saveStats => {
                logger.info(`成功完成用户 ${screen_name} 的推文数据获取和保存: 新增 ${saveStats.new}, 更新 ${saveStats.updated}, 跳过 ${saveStats.skipped}`);
            }).catch(error => {
                logger.error(`保存用户 ${screen_name} 的推文时出错: ${error.message}`);
            });

            // 立即返回结果，不等待数据库操作完成
            return tweets.length;
        } catch (error) {
            const userString = typeof user === 'string' ? user : (user.screen_name || user.id);
            logger.error(`获取用户 ${userString} 的推文时出错: ${error.message}`);
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
            // 从数据库读取用户列表
            const dbUsers = await this.dbManager.getAllUsers();

            if (!dbUsers || dbUsers.length === 0) {
                logger.warn('数据库中没有找到用户数据');
                runStats.endTime = new Date();
                return runStats;
            }

            const totalUsers = dbUsers.length;
            logger.info(`找到 ${totalUsers} 个用户需要获取数据`);

            // 将用户列表分成多批次并行处理
            const processBatch = async (userBatch, batchIndex) => {
                logger.info(`开始处理批次 ${batchIndex + 1}，包含 ${userBatch.length} 个用户`);

                // 批次内的用户采用并行处理
                const batchPromises = userBatch.map(async (user, userIndex) => {
                    // 每个请求稍微延迟，避免瞬时并发过高
                    await this.sleep(userIndex * SPIDER_CONFIG.API_REQUEST_DELAY);

                    try {
                        const tweetCount = await this.pollUserTweets(user);
                        runStats.totalTweets += tweetCount;
                        runStats.usersProcessed++;
                        logger.info(`已处理 ${runStats.usersProcessed}/${totalUsers} 个用户 (${user.screen_name || user.id})`);
                        return { success: true, user, count: tweetCount };
                    } catch (userError) {
                        logger.error(`处理用户 ${user.screen_name || user.id} 时出错: ${userError.message}`);
                        runStats.errors++;
                        return { success: false, user, error: userError.message };
                    }
                });

                return Promise.all(batchPromises);
            };

            // 分批处理用户列表
            const batchSize = SPIDER_CONFIG.MAX_CONCURRENT_REQUESTS;
            const batches = [];

            // 将用户列表分成多个批次
            for (let i = 0; i < dbUsers.length; i += batchSize) {
                batches.push(dbUsers.slice(i, i + batchSize));
            }

            logger.info(`将 ${totalUsers} 个用户分成 ${batches.length} 个批次处理，每批次最多 ${batchSize} 个用户`);

            // 依次处理每个批次（批次间串行，批次内并行）
            for (let i = 0; i < batches.length; i++) {
                await processBatch(batches[i], i);

                // 批次间添加短暂延迟，让系统喘息
                if (i < batches.length - 1) {
                    await this.sleep(SPIDER_CONFIG.API_REQUEST_DELAY * 5);
                }
            }

            runStats.endTime = new Date();
            const duration = (runStats.endTime.getTime() - runStats.startTime.getTime()) / 1000;

            logger.info(`=== 数据采集完成 ===`);
            logger.info(`开始时间: ${runStats.startTime.toISOString()}`);
            logger.info(`结束时间: ${runStats.endTime.toISOString()}`);
            logger.info(`总用时: ${duration.toFixed(2)}秒`);
            logger.info(`处理用户: ${runStats.usersProcessed}/${totalUsers}`);
            logger.info(`获取推文: ${runStats.totalTweets}条`);
            logger.info(`错误数量: ${runStats.errors}`);
            logger.info(`平均每秒处理: ${(runStats.usersProcessed / duration).toFixed(2)} 个用户`);

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

    /**
     * 从数据库获取并更新所有用户的关注列表
     * @returns {Promise<Object>} 统计信息
     */
    async fetchAndUpdateAllUsersFollowings() {
        const stats = {
            startTime: new Date(),
            endTime: null,
            totalUsers: 0,
            usersProcessed: 0,
            totalFollowings: 0,
            newFollowings: 0,
            updatedFollowings: 0,
            errors: 0
        };

        try {
            logger.info(`开始从数据库获取所有用户信息...`);

            // 从数据库获取所有用户
            const dbUsers = await this.dbManager.getAllUsers();

            if (!dbUsers || dbUsers.length === 0) {
                logger.warn(`数据库中没有找到用户数据`);
                stats.endTime = new Date();
                return stats;
            }

            stats.totalUsers = dbUsers.length;
            logger.info(`从数据库中获取到 ${stats.totalUsers} 个用户，开始更新他们的关注列表`);

            // 定义每批次处理函数
            const processBatch = async (userBatch, batchIndex) => {
                logger.info(`开始处理批次 ${batchIndex + 1}，包含 ${userBatch.length} 个用户的关注列表`);

                // 批次内用户串行处理（关注列表获取包含分页，不适合完全并行）
                for (const user of userBatch) {
                    try {
                        logger.info(`正在处理用户 ${user.screen_name} (ID: ${user.id})...`);
                        const userStats = await this.fetchAndStoreAllFollowings(user.id);

                        // 更新统计信息
                        stats.usersProcessed++;
                        stats.totalFollowings += userStats.totalFollowings;
                        stats.newFollowings += userStats.newFollowings;
                        stats.updatedFollowings += userStats.updatedFollowings;
                        stats.errors += userStats.errors;

                        logger.info(`用户 ${user.screen_name} 的关注列表更新完成，共 ${userStats.totalFollowings} 个关注，已处理 ${stats.usersProcessed}/${stats.totalUsers} 个用户`);
                    } catch (error) {
                        logger.error(`处理用户 ${user.screen_name} 时出错: ${error.message}`);
                        stats.errors++;
                        stats.usersProcessed++;
                    }
                }

                return true;
            };

            // 分批处理用户列表 - 关注列表获取比较耗时，使用较小批次
            const batchSize = 5; // 每批最多5个用户
            const batches = [];

            // 将用户列表分成多个批次
            for (let i = 0; i < dbUsers.length; i += batchSize) {
                batches.push(dbUsers.slice(i, i + batchSize));
            }

            logger.info(`将 ${stats.totalUsers} 个用户分成 ${batches.length} 个批次处理，每批次 ${batchSize} 个用户`);

            // 依次处理每个批次
            for (let i = 0; i < batches.length; i++) {
                await processBatch(batches[i], i);

                // 批次间添加短暂延迟
                if (i < batches.length - 1) {
                    logger.info(`批次 ${i + 1} 处理完成，短暂休息后继续下一批次...`);
                    await this.sleep(SPIDER_CONFIG.API_REQUEST_DELAY * 10);
                }
            }

            stats.endTime = new Date();
            const duration = (stats.endTime.getTime() - stats.startTime.getTime()) / 1000;

            logger.info(`=== 所有用户关注列表更新完成 ===`);
            logger.info(`开始时间: ${stats.startTime.toISOString()}`);
            logger.info(`结束时间: ${stats.endTime.toISOString()}`);
            logger.info(`总用时: ${duration.toFixed(2)}秒`);
            logger.info(`总用户数: ${stats.totalUsers}个`);
            logger.info(`处理成功: ${stats.usersProcessed}个`);
            logger.info(`获取关注: ${stats.totalFollowings}个`);
            logger.info(`新增关注: ${stats.newFollowings}个`);
            logger.info(`更新关注: ${stats.updatedFollowings}个`);
            logger.info(`错误数量: ${stats.errors}`);
            logger.info(`平均每秒处理: ${(stats.usersProcessed / duration).toFixed(2)} 个用户`);

            return stats;
        } catch (error) {
            logger.error(`获取所有用户关注列表时出错: ${error.message}`);
            stats.endTime = new Date();
            stats.errors++;
            return stats;
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

        // 检查命令行参数
        if (process.argv.includes('--test')) {
            // 测试模式运行
            poller.test().then((stats) => {
                logger.info(`测试统计: 处理用户 ${stats.usersProcessed} 个，获取推文 ${stats.totalTweets} 条，用时 ${((stats.endTime - stats.startTime) / 1000).toFixed(2)} 秒`);
                poller.close();
                process.exit(0);
            }).catch(error => {
                logger.error(`测试失败: ${error.message}`);
                poller.close();
                process.exit(1);
            });
        } else if (process.argv.includes('--fetch-followings')) {
            // 从数据库读取所有用户并更新他们的关注列表
            logger.info(`开始更新数据库中所有用户的关注列表`);
            poller.fetchAndUpdateAllUsersFollowings().then((stats) => {
                logger.info(`所有用户关注列表更新完成: 共处理 ${stats.usersProcessed}/${stats.totalUsers} 个用户，获取 ${stats.totalFollowings} 个关注，用时 ${((stats.endTime - stats.startTime) / 1000).toFixed(2)} 秒`);
                poller.close();
                process.exit(0);
            }).catch(error => {
                logger.error(`更新所有用户关注列表失败: ${error.message}`);
                poller.close();
                process.exit(1);
            });
        } else {
            logger.info(`=== Twitter 数据采集服务启动 ===`);
            logger.info(`时间: ${new Date().toLocaleString()}`);
            logger.info(`计划: 每小时整点自动获取推文数据`);
            logger.info(`数据来源: 从数据库users表获取用户，然后抓取这些用户的最新推文`);
            logger.info(`注意: 用户关注列表更新不会自动执行，需要手动运行 --fetch-followings 命令`);
            poller.startPolling();
        }
    } catch (error) {
        logger.error(`启动服务时出错: ${error.message}`);
        process.exit(1);
    }
}

// 仅在直接运行此文件时执行主函数
if (require.main === module) {
    main();
}

// 导出类和常量，使其他模块可以导入使用
module.exports = {
    TwitterPoller,
    SPIDER_CONFIG
}; 