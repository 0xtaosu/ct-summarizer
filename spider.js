/**
 * Twitter/X 数据采集器
 * 
 * 功能：
 * - 通过 RapidAPI Twitter241 API 采集 Twitter 用户推文数据
 * - 获取用户关注列表和粉丝列表
 * - 批量获取用户信息
 * - 数据存储到 SQLite 数据库
 * 
 * @module spider
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const schedule = require('node-schedule');
const { createLogger } = require('./logger');
const { DatabaseManager } = require('./data');
const { FOLLOWER_SOURCE_ACCOUNT, TWITTER_LIST_IDS } = require('./config');

/**
 * 配置常量
 */
const SPIDER_CONFIG = {
    API_BASE_URL: 'https://twitter241.p.rapidapi.com',
    RAPIDAPI_HOST: 'twitter241.p.rapidapi.com',
    POLL_INTERVAL: '0 * * * *',           // 定时任务：每小时整点执行
    API_REQUEST_DELAY: 100,                // API请求间隔（毫秒）
    MAX_CONCURRENT_REQUESTS: 10,           // 最大并发请求数
    MAX_TWEETS_PER_REQUEST: 100,           // 每次获取推文数量
    MAX_FOLLOWINGS_PER_REQUEST: 70,        // 每次获取关注列表数量
    FOLLOWER_SOURCE_ACCOUNT: FOLLOWER_SOURCE_ACCOUNT,
    TWITTER_LIST_IDS: TWITTER_LIST_IDS
};

const logger = createLogger('spider');

/**
 * Twitter数据采集器类
 */
class TwitterPoller {
    /**
     * 构造函数
     * @param {boolean} skipApiInit - 是否跳过API初始化（用于仅需数据库操作的场景）
     * @throws {Error} 如果环境变量中没有设置API密钥且未跳过API初始化
     */
    constructor(skipApiInit = false) {
        // 初始化数据库 (写入模式)
        this.dbManager = new DatabaseManager(false);

        // 如果跳过API初始化，则不需要API密钥
        if (skipApiInit) {
            logger.info('跳过API初始化，仅使用数据库功能');
            this.client = null;
            this.apiKey = null;
        } else {
            // 初始化RapidAPI客户端
            this.apiKey = process.env.RAPIDAPI_KEY;
        if (!this.apiKey) {
                throw new Error("RAPIDAPI_KEY not found in environment variables");
        }

            // 创建API客户端
        this.client = axios.create({
                baseURL: SPIDER_CONFIG.API_BASE_URL,
            headers: {
                    'x-rapidapi-key': this.apiKey,
                    'x-rapidapi-host': SPIDER_CONFIG.RAPIDAPI_HOST
                },
                timeout: 30000 // 设置30秒超时
            });
        }

        // 初始化统计信息
        this.stats = {
            totalRuns: 0,
            lastRunTime: null,
            nextRunTime: null,
            totalTweetsCollected: 0,
            usersCounted: 0,
            listsCounted: 0,
            lastFollowerUpdate: null,
            totalFollowersTracked: 0
        };

        logger.info('Twitter数据采集器已初始化（使用RapidAPI）');
    }

    // ==================== 辅助方法 ====================

    /**
     * 从API响应中提取数组数据（处理多种可能的响应结构）
     * @param {*} data - API响应数据
     * @param {string} arrayKey - 数组字段名（如 'users', 'ids'）
     * @returns {Array} 提取的数组，失败时返回空数组
     * @private
     */
    _extractArrayFromResponse(data, arrayKey = null) {
        // 直接是数组
        if (Array.isArray(data)) {
            return data;
        }

        // 包含指定键的数组
        if (arrayKey && data[arrayKey] && Array.isArray(data[arrayKey])) {
            return data[arrayKey];
    }

        // 包含在 result 中
        if (data.result) {
            if (Array.isArray(data.result)) {
                return data.result;
            }
            if (arrayKey && data.result[arrayKey] && Array.isArray(data.result[arrayKey])) {
                return data.result[arrayKey];
            }
        }

        // 包含在 data 中
        if (data.data) {
            if (Array.isArray(data.data)) {
                return data.data;
            }
            if (arrayKey && data.data[arrayKey] && Array.isArray(data.data[arrayKey])) {
                return data.data[arrayKey];
            }
        }

        return [];
    }

    /**
     * 从用户数据中提取标准化的用户对象
     * @param {Object} userData - 用户数据（可能包含嵌套结构或扁平结构）
     * @returns {Object|null} 标准化的用户对象，失败时返回 null
     * @private
     */
    _extractUserObject(userData) {
        if (!userData) {
            return null;
        }

        let user = null;
        let isFlatFormat = false;

        // 优先检查嵌套格式（Twitter API 标准格式）
        // 嵌套格式的特征：有 rest_id 和 legacy 字段
        if (userData.rest_id && userData.legacy) {
            user = userData;
        }
        // 包含在 result 中
        else if (userData.result?.rest_id && userData.result?.legacy) {
            user = userData.result;
        }
        // 包含在 data.user.result 中
        else if (userData.data?.user?.result?.rest_id && userData.data?.user?.result?.legacy) {
            user = userData.data.user.result;
        }
        // 检查是否是扁平格式（只有当不是嵌套格式时才判断）
        // 扁平格式的特征：有 screen_name 字段（因为 id 可能存在于嵌套格式中）
        else if (userData.screen_name) {
            // 扁平格式：直接使用 userData
            user = userData;
            isFlatFormat = true;
        }
        // 检查 result 中是否包含扁平格式
        else if (userData.result?.screen_name) {
            user = userData.result;
            isFlatFormat = true;
        }

        if (!user) {
            return null;
        }

        // 处理扁平格式（/get-users-v2 API）
        if (isFlatFormat) {
            const userId = user.id || user.id_str || '';
            const screenName = user.screen_name || '';
            const name = user.name || '';

            if (!userId || !screenName) {
                logger.debug(`扁平格式用户数据缺少必要字段: id=${userId}, screen_name=${screenName}`);
                return null;
            }

            return {
                id: String(userId),
                username: screenName,              // @ 用户名
                screen_name: screenName,            // @ 用户名（与 username 相同）
                name: name,                         // 显示名称
                description: user.description || '',
                followers_count: user.followers_count || 0,
                following_count: user.friends_count || user.following_count || 0,
                tweet_count: user.statuses_count || user.tweet_count || 0,
                profile_image_url: user.profile_image_url || user.profile_image_url_https || '',
                is_following: false,
                is_tracked: false
            };
        }

        // 处理嵌套格式（Twitter API 标准格式）
        if (!user.legacy) {
            return null;
        }

        // 返回标准化的用户数据
        return {
            id: user.rest_id,
            username: user.legacy.screen_name,      // @ 用户名
            screen_name: user.legacy.screen_name,   // @ 用户名（与 username 相同）
            name: user.legacy.name,                 // 显示名称
            description: user.legacy.description || '',
            followers_count: user.legacy.followers_count || 0,
            following_count: user.legacy.friends_count || 0,
            tweet_count: user.legacy.statuses_count || 0,
            profile_image_url: user.legacy.profile_image_url_https || '',
            is_following: false,
            is_tracked: false
        };
    }

    /**
     * 记录 API 错误信息
     * @param {Error} error - 错误对象
     * @param {string} context - 错误上下文描述
     * @private
     */
    logApiError(error, context) {
        if (error.response) {
            logger.error(`${context}: HTTP ${error.response.status} - ${error.response.statusText}`);
            logger.error(`响应数据: ${JSON.stringify(error.response.data).substring(0, 500)}`);
        } else if (error.request) {
            logger.error(`${context}: 无响应 - ${error.message}`);
        } else {
            logger.error(`${context}: ${error.message}`);
        }
    }

    // ==================== 用户信息获取 ====================

    /**
     * 通过用户名获取单个用户信息
     * @param {string} username - 用户名（如 'elonmusk'）
     * @returns {Promise<Object|null>} 用户信息对象，失败时返回 null
     */
    async getUserByUsername(username) {
        try {
            logger.info(`正在获取用户 ${username} 的信息...`);

            const userResponse = await this.client.get(`/user`, {
                params: { username }
            });

            // 验证响应数据结构
            if (!userResponse.data) {
                logger.error(`找不到用户 ${username}，API返回数据为空`);
                return null;
            }

            // 根据实际API返回结构提取用户数据
            // API返回格式: {user: {result: {rest_id, legacy: {...}}}}
            let userData = null;
            const responseData = userResponse.data;

            // 路径1: user.result (RapidAPI /user 端点返回的格式)
            if (responseData.user?.result) {
                userData = responseData.user.result;
                logger.debug(`使用路径: user.result`);
            }
            // 路径2: result.data.user.result (其他可能的嵌套格式)
            else if (responseData.result?.data?.user?.result) {
                userData = responseData.result.data.user.result;
                logger.debug(`使用路径: result.data.user.result`);
            }
            // 路径3: result.result
            else if (responseData.result?.result) {
                userData = responseData.result.result;
                logger.debug(`使用路径: result.result`);
            }
            // 路径4: result
            else if (responseData.result) {
                userData = responseData.result;
                logger.debug(`使用路径: result`);
            }
            // 路径5: data.user.result
            else if (responseData.data?.user?.result) {
                userData = responseData.data.user.result;
                logger.debug(`使用路径: data.user.result`);
            }
            // 路径6: data
            else if (responseData.data) {
                userData = responseData.data;
                logger.debug(`使用路径: data`);
            }
            // 路径7: 直接是用户对象（扁平格式）
            else if (responseData.id || responseData.id_str || responseData.rest_id) {
                userData = responseData;
                logger.debug(`使用路径: 根对象`);
            }

            if (!userData) {
                logger.error(`找不到用户 ${username}，API返回数据格式不符合预期`);
                logger.debug(`API响应结构: ${JSON.stringify(responseData).substring(0, 1000)}`);
                return null;
            }

            // 使用统一的用户提取方法
            const userInfo = this._extractUserObject(userData);
            if (!userInfo) {
                logger.error(`无法从API响应中提取用户 ${username} 的信息`);
                logger.debug(`用户数据: ${JSON.stringify(userData).substring(0, 500)}`);
                return null;
            }

            logger.info(`成功获取用户信息: ${userInfo.name} (@${userInfo.username}), ID: ${userInfo.id}`);
            return userInfo;
        } catch (error) {
            this.logApiError(error, `获取用户 ${username} 信息时出错`);
            return null;
        }
    }


    /**
     * 批量获取多个用户的详细信息
     * @param {Array<string>} userIds - 用户ID数组
     * @returns {Promise<Array>} 用户信息对象数组，失败时返回空数组
     */
    async getUsersByUserIds(userIds) {
        try {
            if (!userIds || userIds.length === 0) {
                logger.warn('用户ID数组为空');
                return [];
            }

            // 过滤无效的用户ID
            const validUserIds = userIds
                .filter(id => id && String(id).trim().length > 0)
                .map(id => String(id).trim());

            if (validUserIds.length === 0) {
                logger.warn('过滤后没有有效的用户ID');
                return [];
            }

            logger.info(`正在批量获取 ${validUserIds.length} 个用户的信息...`);

            const usersResponse = await this.client.get(`/get-users`, {
                params: { users: validUserIds.join(', ') }
            });

            if (!usersResponse.data) {
                logger.error('API返回数据格式不符合预期');
                return [];
            }

            // 根据实际API返回结构提取用户数组
            // API返回格式: {result: {data: {users: [用户对象数组]}}}
            let usersArray = [];
            const responseData = usersResponse.data;

            // 优先检查 result.data.users 字段（RapidAPI /get-users 端点返回的格式）
            if (responseData.result?.data?.users && Array.isArray(responseData.result.data.users)) {
                usersArray = responseData.result.data.users;
                logger.debug(`从 result.data.users 字段提取到 ${usersArray.length} 个用户`);
            }
            // 备用路径1: result.users
            else if (responseData.result?.users && Array.isArray(responseData.result.users)) {
                usersArray = responseData.result.users;
                logger.debug(`从 result.users 字段提取到 ${usersArray.length} 个用户`);
            }
            // 备用路径2: data.users
            else if (responseData.data?.users && Array.isArray(responseData.data.users)) {
                usersArray = responseData.data.users;
                logger.debug(`从 data.users 字段提取到 ${usersArray.length} 个用户`);
            }
            // 备用路径3: 使用辅助方法尝试其他可能的路径
            else {
                usersArray = this._extractArrayFromResponse(responseData, 'users');
            }

            if (usersArray.length === 0) {
                logger.warn(`无法从API响应中提取用户数组，可能这批用户ID无效或已被删除`);
                logger.debug(`请求的用户ID: ${validUserIds.slice(0, 10).join(', ')}${validUserIds.length > 10 ? '...' : ''}`);
                logger.debug(`API响应结构: ${JSON.stringify(responseData).substring(0, 500)}`);
                return [];
            }

            // 使用辅助方法处理每个用户
            // 注意：API返回的每个用户对象都包装在 {result: {...}} 中
            const processedUsers = [];
            for (const userWrapper of usersArray) {
                // 提取 result 字段中的实际用户数据
                const userData = userWrapper.result || userWrapper;
                const user = this._extractUserObject(userData);
                if (user) {
                    processedUsers.push(user);
                } else {
                    // 提供更详细的调试信息
                    const hasRestId = !!userData?.rest_id;
                    const hasLegacy = !!userData?.legacy;
                    const hasScreenName = !!userData?.screen_name;
                    logger.warn(`无法解析用户数据 (rest_id: ${hasRestId}, legacy: ${hasLegacy}, screen_name: ${hasScreenName}): ${JSON.stringify(userData).substring(0, 200)}`);
                }
            }

            logger.info(`成功获取到 ${processedUsers.length}/${validUserIds.length} 个用户的信息`);
            return processedUsers;

        } catch (error) {
            // 如果是404错误，可能是部分用户ID无效
            if (error.response?.status === 404) {
                logger.warn(`批量获取用户信息时返回404，可能部分用户ID无效或账号已被删除/暂停`);
                logger.debug(`请求的用户ID数量: ${userIds.length}`);

                // 如果批次较大，尝试分成更小的批次重试
                if (userIds.length > 10) {
                    logger.info(`尝试将批次拆分为更小的批次重试...`);
                    const halfSize = Math.floor(userIds.length / 2);
                    const firstHalf = userIds.slice(0, halfSize);
                    const secondHalf = userIds.slice(halfSize);

                    // 递归调用，分别处理两半
                    const [firstResults, secondResults] = await Promise.all([
                        this.getUsersByUserIds(firstHalf),
                        this.getUsersByUserIds(secondHalf)
                    ]);

                    const combinedResults = [...firstResults, ...secondResults];
                    logger.info(`分批重试完成，共获取到 ${combinedResults.length}/${userIds.length} 个用户的信息`);
                    return combinedResults;
                }
            } else {
                this.logApiError(error, `批量获取用户信息时出错`);
            }
            return [];
        }
    }

    // ==================== 推文获取 ====================

    /**
     * 获取指定用户的推文
     * @param {string} userId - 用户ID
     * @param {string} username - 用户名（@ 用户名）
     * @param {string} screen_name - 屏幕名称（与 username 相同）
     * @returns {Promise<Array>} 推文对象数组，失败时返回空数组
     */
    async getUserTweets(userId, username, screen_name) {
        try {
            logger.info(`正在获取用户 ${username} (ID: ${userId}) 的推文...`);

            const tweetsResponse = await this.client.get(`/user-tweets`, {
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
     * 获取Twitter列表的推文时间线
     * @param {string} listId - Twitter列表ID
     * @param {number} count - 获取推文数量（可选，默认100）
     * @returns {Promise<Array>} 推文对象数组
     */
    async getListTimeline(listId, count = 100) {
        try {
            logger.info(`正在获取列表 ${listId} 的推文时间线...`);

            const timelineResponse = await this.client.get(`/list-timeline`, {
                params: {
                    listId: listId,
                    count: count
                }
            });

            // 验证响应数据结构
            if (!timelineResponse.data?.result?.timeline?.instructions) {
                logger.error(`无法获取列表 ${listId} 的推文，API返回数据格式不符合预期`);
                return [];
            }

            // 寻找TimelineAddEntries指令
            const addEntriesInstruction = timelineResponse.data.result.timeline.instructions.find(
                instruction => instruction.type === 'TimelineAddEntries'
            );

            if (!addEntriesInstruction?.entries) {
                logger.error(`列表 ${listId} 的推文数据结构不符合预期，找不到TimelineAddEntries指令或entries`);
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

                    // 尝试提取用户信息
                    const tweetResults = entry.content?.itemContent?.tweet_results;
                    const tweetData = tweetResults?.result;
                    const userInfo = tweetData?.core?.user_results?.result;

                    if (userInfo?.legacy) {
                        tweet.user_id = userInfo.rest_id;
                        tweet.username = userInfo.legacy.screen_name;  // @ 用户名
                        tweet.screen_name = userInfo.legacy.screen_name;  // @ 用户名（和 username 一样）
                    } else {
                        // 如果无法提取用户信息，使用占位符
                        tweet.user_id = 'unknown';
                        tweet.username = 'unknown';
                        tweet.screen_name = 'unknown';
                    }

                    processedTweets.push(tweet);
                } else {
                    // 统计非推文条目
                    nonTweetEntries++;
                }
            }

            // 详细日志记录处理结果
            const totalEntries = addEntriesInstruction.entries.length;
            logger.info(`成功获取列表 ${listId} 的 ${processedTweets.length} 条推文 (API返回条目总数: ${totalEntries}, 有效推文: ${validEntries}, 非推文条目: ${nonTweetEntries})`);

            return processedTweets;
        } catch (error) {
            this.logApiError(error, `获取列表 ${listId} 推文时间线时出错`);
            return [];
        }
    }

    // ==================== 关注和粉丝列表获取 ====================

    /**
     * 获取用户的关注ID列表
     * @param {string} username - 用户名（如 'mrbeast'）
     * @param {number} count - 获取数量（默认500）
     * @param {string|number} cursor - 分页游标（可选）
     * @returns {Promise<Object>} {ids: Array<string>, nextCursor: string|null} 关注ID数组和下一页游标
     */
    async getUserFollowingIds(username, count = 500, cursor = null) {
        try {
            logger.info(`正在获取用户 ${username} 的关注ID列表 (数量: ${count})${cursor ? ', 游标: ' + cursor : ''}...`);

            const params = {
                username,
                count: count.toString()
            };

            // 如果提供了游标，添加到请求中
            if (cursor) {
                params.cursor = cursor.toString();
            }

            const followingsResponse = await this.client.get(`/following-ids`, { params });

            if (!followingsResponse.data) {
                logger.error(`无法获取用户 ${username} 的关注ID列表`);
                return { ids: [], nextCursor: null };
            }

            // 提取ID数组
            let followingIds = [];
            if (followingsResponse.data.ids && Array.isArray(followingsResponse.data.ids)) {
                followingIds = followingsResponse.data.ids;
            } else {
                followingIds = this._extractArrayFromResponse(followingsResponse.data, 'ids');
            }

            // 确保所有ID都是字符串格式并过滤无效值
            followingIds = followingIds
                .map(id => String(id))
                .filter(id => id && id !== 'undefined' && id !== 'null');

            // 提取下一页游标
            let nextCursor = null;
            if (followingsResponse.data.next_cursor_str) {
                nextCursor = followingsResponse.data.next_cursor_str;
            } else if (followingsResponse.data.next_cursor) {
                nextCursor = String(followingsResponse.data.next_cursor);
            }

            // 如果游标为 "0" 或 0，表示没有更多页面
            if (nextCursor === '0' || nextCursor === 'null') {
                nextCursor = null;
            }

            logger.info(`成功获取到用户 ${username} 的 ${followingIds.length} 个关注ID${nextCursor ? ', 下一页游标: ' + nextCursor : ''}`);
            return { ids: followingIds, nextCursor };

        } catch (error) {
            this.logApiError(error, `获取用户 ${username} 关注ID列表时出错`);
            return { ids: [], nextCursor: null };
        }
    }



    /**
     * 获取用户的关注详细信息（先获取关注ID列表，再批量获取完整用户信息）
     * @param {string} username - 用户名或用户ID
     * @param {string|number} cursor - 分页游标（可选）
     * @returns {Promise<Object>} {followings: Array, nextCursor: string|null} 关注用户详细信息数组和下一页游标
     */
    async getUserFollowingWithDetails(username, cursor = null) {
        try {
            logger.info(`正在获取用户 ${username} 的关注详细信息${cursor ? ' (使用游标: ' + cursor + ')' : ''}...`);

            // 第一步：获取关注ID列表
            const result = await this.getUserFollowingIds(username, SPIDER_CONFIG.MAX_FOLLOWINGS_PER_REQUEST, cursor);
            const userIds = result.ids;
            const nextCursor = result.nextCursor;

            if (userIds.length === 0) {
                logger.warn(`用户 ${username} 没有获取到关注用户ID`);
                return { followings: [], nextCursor: null };
            }

            logger.info(`获取到 ${userIds.length} 个关注用户ID，开始批量获取详细信息...`);

            // 第二步：批量获取完整用户信息
            // 调整批次大小为50，避免单次请求过多用户导致404
            const batchSize = 50;
            const allFollowings = [];

            for (let i = 0; i < userIds.length; i += batchSize) {
                const batch = userIds.slice(i, i + batchSize);
                const batchNumber = Math.floor(i / batchSize) + 1;
                const totalBatches = Math.ceil(userIds.length / batchSize);

                logger.info(`正在获取第 ${batchNumber}/${totalBatches} 批关注用户信息 (${batch.length} 个用户)...`);

                const batchUsers = await this.getUsersByUserIds(batch);
                if (batchUsers.length > 0) {
                    allFollowings.push(...batchUsers);
                } else {
                    logger.warn(`第 ${batchNumber} 批未获取到任何用户信息`);
                }

                // 添加延迟以避免API限流，增加到1秒
                if (i + batchSize < userIds.length) {
                    await this.sleep(1000);
                }
            }

            logger.info(`成功获取到用户 ${username} 的 ${allFollowings.length}/${userIds.length} 个关注用户的详细信息`);
            return { followings: allFollowings, nextCursor };

        } catch (error) {
            this.logApiError(error, `获取用户 ${username} 关注详细信息时出错`);
            return { followings: [], nextCursor: null };
        }
    }



    // ==================== 数据提取辅助方法 ====================

    /**
     * 从 Timeline Entry 中提取推文数据
     * @param {Object} entry - Timeline 条目对象
     * @returns {Object|null} 规范化的推文数据，无效条目返回 null
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
            logger.warn(`推文 ${tweet.rest_id || tweet.id || 'unknown'} 缺少legacy属性，已跳过`);
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
     * 从关注列表条目中提取用户信息
     * @param {Object} entry - 关注列表 Timeline 条目对象
     * @returns {Object|null} 规范化的用户数据，无效条目返回 null
     * @private
     */
    extractUserFromFollowingEntry(entry) {
        if (!entry.content?.itemContent || entry.content.itemContent.itemType !== 'TimelineUser') {
            return null;
        }

        const userResults = entry.content.itemContent.user_results;
        if (!userResults?.result) {
            return null;
        }

        // 使用统一的用户提取方法
        return this._extractUserObject(userResults.result);
    }

    // ==================== 批量操作和定时任务 ====================

    /**
     * 获取并存储指定用户关注的所有用户（支持分页）
     * @param {string} username - 目标用户名
     * @param {string} startCursor - 起始游标（可选）
     * @returns {Promise<Object>} 包含统计信息的对象
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

                // 获取一页关注列表（使用详细信息方法）
                const result = await this.getUserFollowingWithDetails(username, nextCursor);
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
                // username 和 screen_name 应该是一样的（都是 @ 用户名）
                // 优先使用 screen_name，如果不存在则使用 username
                screen_name = user.screen_name || user.username;
                username = screen_name;  // 确保 username 和 screen_name 一致
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
     * 获取并保存单个Twitter列表的推文
     * @param {string} listId - Twitter列表ID
     * @param {number} count - 获取推文数量
     * @returns {Promise<Object>} 单个列表的处理结果
     */
    async pollList(listId, count = SPIDER_CONFIG.MAX_TWEETS_PER_REQUEST) {
        const result = {
            listId,
            success: false,
            tweetsCount: 0,
            newTweets: 0,
            updatedTweets: 0,
            error: null
        };

        try {
            const tweets = await this.getListTimeline(listId, count);

            if (tweets.length === 0) {
                logger.warn(`列表 ${listId} 未获取到推文`);
                result.success = true;
                return result;
            }

            const saveStats = await this.dbManager.saveTweetsToDatabase(tweets);
            logger.info(`列表 ${listId} 推文保存完成: 新增 ${saveStats.new}, 更新 ${saveStats.updated}, 跳过 ${saveStats.skipped}`);

            result.success = true;
            result.tweetsCount = tweets.length;
            result.newTweets = saveStats.new;
            result.updatedTweets = saveStats.updated;

            return result;
        } catch (error) {
            logger.error(`获取列表 ${listId} 的推文时出错: ${error.message}`);
            result.error = error.message;
            return result;
        }
    }

    /**
     * 获取所有配置的Twitter列表推文
     * @param {string[]} [listIds=SPIDER_CONFIG.TWITTER_LIST_IDS] - 要拉取的列表ID
     * @returns {Promise<Object>} 统计信息
     */
    async pollAllLists(listIds = SPIDER_CONFIG.TWITTER_LIST_IDS) {
        const runStats = {
            startTime: new Date(),
            endTime: null,
            totalTweets: 0,
            listsProcessed: 0,
            errors: 0,
            listResults: []
        };

        const targets = listIds && listIds.length ? listIds : [];
        if (targets.length === 0) {
            logger.warn('没有配置需要拉取的Twitter列表ID');
            runStats.endTime = new Date();
            return runStats;
        }

        logger.info(`开始拉取 ${targets.length} 个Twitter列表的推文...`);

        for (const listId of targets) {
            const result = await this.pollList(listId, SPIDER_CONFIG.MAX_TWEETS_PER_REQUEST);

            if (!result.success) {
                runStats.errors++;
            } else {
                runStats.totalTweets += result.tweetsCount;
                runStats.listsProcessed++;
            }

            runStats.listResults.push(result);
        }

        runStats.endTime = new Date();
        const duration = (runStats.endTime.getTime() - runStats.startTime.getTime()) / 1000;

        logger.info(`=== 列表拉取完成 ===`);
        logger.info(`处理列表: ${runStats.listsProcessed}/${targets.length}`);
        logger.info(`获取推文: ${runStats.totalTweets}条`);
        logger.info(`错误数量: ${runStats.errors}`);
        logger.info(`总用时: ${duration.toFixed(2)}秒`);

        this.updateStats(runStats);

        return runStats;
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
        this.stats.usersCounted += runStats.usersProcessed || 0;
        this.stats.listsCounted = (this.stats.listsCounted || 0) + (runStats.listsProcessed || 0);

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
        // 立即执行一次列表数据采集
        logger.info('服务启动，立即执行首次列表数据采集...');
        this.pollAllLists().then(() => {
            logger.info('首次列表数据采集完成，已设置定时任务');
        }).catch(error => {
            logger.error(`首次列表数据采集失败: ${error.message}`);
        });

        // 配置定时任务 - 每小时整点执行
        const job = schedule.scheduleJob(SPIDER_CONFIG.POLL_INTERVAL, async () => {
            const now = new Date();
            logger.info(`=== 开始定时列表数据采集 (${now.toLocaleString()}) ===`);
            await this.pollAllLists();
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
        logger.info('=== 开始测试列表数据获取 ===');
        const stats = await this.pollAllLists();
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
     * 导出关注列表为CSV文件
     * @param {string} outputPath - 输出文件路径（可选）
     * @returns {Promise<Object>} 导出结果统计
     */
    async exportFollowingsToCSV(outputPath = null) {
        try {
            logger.info('开始导出关注列表为CSV文件...');

            // 从数据库获取所有用户
            const users = await this.dbManager.getAllUsers();

            if (!users || users.length === 0) {
                logger.warn('数据库中没有用户数据，无法导出');
                return {
                    success: false,
                    message: '数据库中没有用户数据',
                    count: 0
                };
            }

            logger.info(`从数据库获取到 ${users.length} 个用户`);

            // 设置默认输出路径
            const defaultPath = path.join('data', 'twitter_followings_export.csv');
            const filePath = outputPath || defaultPath;

            // 确保data目录存在
            const dirPath = path.dirname(filePath);
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
                logger.info(`已创建目录: ${dirPath}`);
            }

            // 准备CSV内容
            // CSV头部
            const headers = [
                'id',
                'username',
                'screen_name',
                'name',
                'description',
                'followers_count',
                'following_count',
                'tweet_count',
                'profile_image_url',
                'is_following',
                'is_tracked',
                'last_updated'
            ];

            // 构建CSV行
            const csvLines = [headers.join(',')];

            // 添加每个用户的数据
            for (const user of users) {
                const row = [
                    user.id || '',
                    this._escapeCSVField(user.username || ''),
                    user.screen_name || '',
                    this._escapeCSVField(user.name || ''),
                    this._escapeCSVField(user.description || ''),
                    user.followers_count || 0,
                    user.following_count || 0,
                    user.tweet_count || 0,
                    user.profile_image_url || '',
                    user.is_following || 0,
                    user.is_tracked || 0,
                    user.last_updated || ''
                ];
                csvLines.push(row.join(','));
            }

            // 写入文件
            const csvContent = csvLines.join('\n');
            fs.writeFileSync(filePath, csvContent, 'utf-8');

            logger.info(`成功导出 ${users.length} 个用户到文件: ${filePath}`);

            return {
                success: true,
                filePath: filePath,
                count: users.length,
                message: `成功导出 ${users.length} 个用户`
            };
        } catch (error) {
            logger.error(`导出关注列表为CSV时出错: ${error.message}`);
            return {
                success: false,
                message: `导出失败: ${error.message}`,
                count: 0
            };
        }
    }

    /**
     * 转义CSV字段（处理包含逗号、引号和换行符的字段）
     * @param {string} field - 要转义的字段
     * @returns {string} 转义后的字段
     * @private
     */
    _escapeCSVField(field) {
        if (field == null) {
            return '';
        }

        const fieldStr = String(field);

        // 如果字段包含逗号、双引号或换行符，需要用双引号包围
        if (fieldStr.includes(',') || fieldStr.includes('"') || fieldStr.includes('\n') || fieldStr.includes('\r')) {
            // 将字段中的双引号转义为两个双引号
            const escapedField = fieldStr.replace(/"/g, '""');
            return `"${escapedField}"`;
        }

        return fieldStr;
    }
}

/**
 * 主函数
 */
function main() {
    try {
        logger.info('启动Twitter数据采集器...');

        // 检查命令行参数
        const args = process.argv.slice(2);

        // 处理导出关注列表为CSV的命令（不需要API密钥）
        if (args.includes('--export-followings')) {
            // 创建采集器实例（跳过API初始化）
            const poller = new TwitterPoller(true);
            logger.info('检测到 --export-followings 参数，将导出关注列表为CSV文件...');

            // 查找是否指定了输出路径
            const outputIndex = args.indexOf('--output');
            let outputPath = null;

            if (outputIndex !== -1 && args.length > outputIndex + 1) {
                outputPath = args[outputIndex + 1];
                logger.info(`将使用指定的输出路径: ${outputPath}`);
            }

            // 执行导出操作
            poller.exportFollowingsToCSV(outputPath)
                .then(result => {
                    if (result.success) {
                        logger.info(`✓ ${result.message}`);
                        logger.info(`文件路径: ${result.filePath}`);
                        console.log(`\n导出成功！`);
                        console.log(`- 导出用户数: ${result.count}`);
                        console.log(`- 文件路径: ${result.filePath}`);
                    } else {
                        logger.error(`✗ ${result.message}`);
                        console.log(`\n导出失败: ${result.message}`);
                    }

                    poller.close();
                    process.exit(result.success ? 0 : 1);
                })
                .catch(error => {
                    logger.error(`导出关注列表失败: ${error.message}`);
                    console.log(`\n导出失败: ${error.message}`);
                    poller.close();
                    process.exit(1);
                });

            return; // 不继续执行下面的代码
        }

        // 为其他命令创建需要API的采集器实例
        const poller = new TwitterPoller();

        // 处理获取关注列表的命令
        if (args.includes('--fetch-followings')) {
            logger.info('检测到 --fetch-followings 参数，将获取关注列表...');

            // 查找是否指定了用户
            let targetUser = SPIDER_CONFIG.FOLLOWER_SOURCE_ACCOUNT; // 默认使用配置的源账号
            let userIdMode = false;

            const userIndex = args.indexOf('--user');
            const userIdIndex = args.indexOf('--userid');

            if (userIndex !== -1 && args.length > userIndex + 1) {
                targetUser = args[userIndex + 1];
                logger.info(`将使用指定的用户名: ${targetUser}`);
            } else if (userIdIndex !== -1 && args.length > userIdIndex + 1) {
                targetUser = args[userIdIndex + 1];
                userIdMode = true;
                logger.info(`将使用指定的用户ID: ${targetUser}`);
            } else {
                logger.info(`将使用配置文件中的源账号: ${targetUser}`);
            }

            logger.info(`开始获取 ${targetUser} 的关注列表...`);

            // 执行关注列表获取
            poller.fetchAndStoreAllFollowings(targetUser)
                .then(stats => {
                    logger.info(`成功完成关注列表获取操作: 共获取 ${stats.totalFollowings} 个用户`);
                    logger.info(`新增用户: ${stats.newFollowings}, 更新用户: ${stats.updatedFollowings}`);

                    // 检查是否需要立即收集推文
                    if (args.includes('--collect-after')) {
                        logger.info('检测到 --collect-after 参数，将立即开始收集推文数据...');
                        return poller.pollAllUsers().then(tweetStats => {
                            logger.info(`推文收集完成: 共处理 ${tweetStats.usersProcessed} 个用户, 收集了 ${tweetStats.totalTweets} 条推文`);
                            poller.close();
                            process.exit(0);
                        });
                    } else {
                        logger.info('关注列表获取已完成。如需立即收集推文，请使用 --collect-after 参数');
                        poller.close();
                        process.exit(0);
                    }
                })
                .catch(error => {
                    logger.error(`获取关注列表失败: ${error.message}`);
                    poller.close();
                    process.exit(1);
                });

            return; // 不继续执行下面的代码
        }

        // 单独收集推文的命令
        if (args.includes('--collect-tweets')) {
            logger.info('检测到 --collect-tweets 参数，将立即收集所有用户的推文...');

            poller.pollAllUsers()
                .then(stats => {
                    logger.info(`推文收集完成: 共处理 ${stats.usersProcessed} 个用户, 收集了 ${stats.totalTweets} 条推文`);
                    poller.close();
                    process.exit(0);
                })
                .catch(error => {
                    logger.error(`收集推文失败: ${error.message}`);
                    poller.close();
                    process.exit(1);
                });

            return; // 不继续执行下面的代码
        }

        // 获取Twitter列表推文的命令
        if (args.includes('--fetch-list')) {
            logger.info('检测到 --fetch-list 参数，将获取Twitter列表的推文...');

            // 查找是否指定了列表ID
            const listIdIndex = args.indexOf('--list-id');

            if (listIdIndex === -1 || args.length <= listIdIndex + 1) {
                logger.error('错误: 必须使用 --list-id 参数指定Twitter列表ID');
                console.log('\n使用方法: node spider.js --fetch-list --list-id <列表ID>');
                console.log('例如: node spider.js --fetch-list --list-id 78468360');
                poller.close();
                process.exit(1);
                return;
            }

            const listId = args[listIdIndex + 1];
            logger.info(`将获取列表ID: ${listId} 的推文`);

            // 可选：指定获取数量
            const countIndex = args.indexOf('--count');
            const count = (countIndex !== -1 && args.length > countIndex + 1)
                ? parseInt(args[countIndex + 1])
                : 100;

            // 获取列表推文
            poller.pollList(listId, count)
                .then((result) => {
                    if (!result.success) {
                        console.log(`\n获取失败: ${result.error || '未知错误'}`);
                        poller.close();
                        process.exit(1);
                        return;
                    }

                    if (result.tweetsCount === 0) {
                        logger.warn(`列表 ${listId} 未获取到推文`);
                        console.log(`\n未获取到推文，列表ID: ${listId}`);
                        poller.close();
                        process.exit(0);
                        return;
                    }

                    logger.info(`成功获取到 ${result.tweetsCount} 条推文`);
                    console.log(`\n成功获取 ${result.tweetsCount} 条推文！`);
                    console.log(`- 新增: ${result.newTweets}`);
                    console.log(`- 更新: ${result.updatedTweets}`);

                    poller.close();
                    process.exit(0);
                })
                .catch(error => {
                    logger.error(`获取列表推文失败: ${error.message}`);
                    console.log(`\n获取失败: ${error.message}`);
                    poller.close();
                    process.exit(1);
                });

            return; // 不继续执行下面的代码
        }

        // 根据环境变量决定启动模式
        if (process.env.TEST_MODE === 'true') {
            logger.info('以测试模式运行...');
            poller.test();
        } else if (process.env.MANUAL_RUN === 'true') {
            logger.info('手动运行采集任务...');
            poller.pollAllLists().then(() => {
                logger.info('采集任务完成，退出程序');
                poller.close();
                process.exit(0);
            }).catch(error => {
                logger.error('采集任务失败:', error);
                poller.close();
                process.exit(1);
            });
        } else {
            // 正常模式：启动定时任务
            logger.info('以定时任务模式运行...');
            poller.startPolling();

            // 注册进程退出处理
            process.on('SIGINT', () => {
                logger.info('接收到中断信号，正在关闭...');
                poller.close();
                process.exit(0);
            });
        }
    } catch (error) {
        logger.error('启动Twitter数据采集器失败:', error);
        process.exit(1);
    }
}

// 如果直接运行此文件，则执行主函数
if (require.main === module) {
    main();
}

// 导出模块
module.exports = {
    TwitterPoller,
    SPIDER_CONFIG
}; 
