/**
 * Twitter数据库管理模块
 * 
 * 本模块负责所有与SQLite数据库相关的操作，包括：
 * - 数据库连接初始化和关闭
 * - 推文数据的查询和检索
 * - 推文数据的插入和更新
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const winston = require('winston');

// 配置常量
const CONFIG = {
    DATABASE_PATH: path.join('data', 'twitter_data.db'),
    USERS_CSV_PATH: path.join('data', 'twitter_users.csv'),
};

// 创建日志记录器
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({ filename: 'database.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

/**
 * 数据库管理类
 * 处理所有数据库操作
 */
class DatabaseManager {
    /**
     * 构造函数
     * @param {boolean} readOnly 是否以只读模式打开数据库
     */
    constructor(readOnly = false) {
        this.dataDir = "data";
        this.dbPath = CONFIG.DATABASE_PATH;
        this.readOnly = readOnly;

        // 初始化数据库
        this.init();
    }

    /**
     * 初始化数据库
     * 创建必要的目录和表结构
     */
    init() {
        try {
            // 确保数据目录存在
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
                logger.info('已创建数据目录');
            }

            // 打开数据库连接
            const openMode = this.readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
            this.db = new sqlite3.Database(this.dbPath, openMode, (err) => {
                if (err) {
                    logger.error(`连接数据库失败: ${err.message}`);
                    throw err;
                }
                logger.info(`已连接到数据库: ${this.dbPath}`);

                // 如果不是只读模式，创建必要的表
                if (!this.readOnly) {
                    this.createTables();
                } else {
                    this.validateTables();
                }
            });
        } catch (error) {
            logger.error(`初始化数据库失败: ${error.message}`);
            this.db = null;
        }
    }

    /**
     * 创建数据库表
     */
    createTables() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS tweets (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                username TEXT,
                screen_name TEXT,
                text TEXT,
                created_at TEXT,
                retweet_count INTEGER,
                like_count INTEGER,
                reply_count INTEGER,
                quote_count INTEGER,
                bookmark_count INTEGER,
                view_count INTEGER,
                collected_at TEXT,
                media_urls TEXT
            )
        `, (err) => {
            if (err) {
                logger.error(`创建tweets表失败: ${err.message}`);
            } else {
                logger.info('tweets表已创建或已存在');
                // 获取总记录数
                this.db.get("SELECT COUNT(*) as count FROM tweets", (err, row) => {
                    if (err) {
                        logger.error(`获取tweets总数失败: ${err.message}`);
                    } else {
                        logger.info(`数据库共有 ${row.count} 条推文记录`);
                    }
                });
            }
        });

        // 创建users表，用于存储用户资料
        this.db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT,
                screen_name TEXT,
                name TEXT,
                description TEXT,
                followers_count INTEGER,
                following_count INTEGER,
                tweet_count INTEGER,
                profile_image_url TEXT,
                is_following BOOLEAN DEFAULT 0,
                is_tracked BOOLEAN DEFAULT 0,
                last_updated TEXT
            )
        `, (err) => {
            if (err) {
                logger.error(`创建users表失败: ${err.message}`);
            } else {
                logger.info('users表已创建或已存在');
                // 获取总记录数
                this.db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
                    if (err) {
                        logger.error(`获取users总数失败: ${err.message}`);
                    } else {
                        logger.info(`数据库共有 ${row.count} 条用户记录`);
                    }
                });
            }
        });
    }

    /**
     * 验证表结构（只读模式下使用）
     */
    validateTables() {
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
    }

    /**
     * 关闭数据库连接
     */
    close() {
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

            // 获取所有推文
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
     * 将推文保存到数据库
     * @param {Array} tweets - 要保存的推文数组
     * @returns {Promise<Object>} 包含保存统计信息的对象
     */
    async saveTweetsToDatabase(tweets) {
        if (!tweets || tweets.length === 0) {
            logger.info('没有推文需要保存');
            return { new: 0, updated: 0, skipped: 0, error: 0 };
        }

        const now = new Date().toISOString();
        const stats = {
            new: 0,      // 新增的推文
            updated: 0,  // 更新的推文
            skipped: 0,  // 跳过的推文（无变化）
            error: 0     // 处理出错的推文
        };

        // 使用事务提高性能
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');

                // 准备语句
                const checkStmt = this.db.prepare('SELECT id, retweet_count, like_count, reply_count, quote_count, bookmark_count, view_count FROM tweets WHERE id = ?');
                const insertStmt = this.db.prepare(`
                    INSERT INTO tweets (
                        id, user_id, username, screen_name, text, created_at,
                        retweet_count, like_count, reply_count, quote_count,
                        bookmark_count, view_count, collected_at, media_urls
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                const updateStmt = this.db.prepare(`
                    UPDATE tweets SET 
                        retweet_count = ?, 
                        like_count = ?, 
                        reply_count = ?, 
                        quote_count = ?,
                        bookmark_count = ?, 
                        view_count = ?, 
                        collected_at = ?
                    WHERE id = ?
                `);

                // 定义处理每条推文的函数
                const processTweets = (index) => {
                    if (index >= tweets.length) {
                        // 所有推文处理完毕，关闭语句并提交事务
                        checkStmt.finalize();
                        insertStmt.finalize();
                        updateStmt.finalize();

                        this.db.run('COMMIT', (err) => {
                            if (err) {
                                logger.error(`提交事务失败: ${err.message}`);
                                reject(err);
                            } else {
                                logger.info(`推文处理统计 - 新增: ${stats.new}, 更新: ${stats.updated}, 跳过: ${stats.skipped}, 错误: ${stats.error}`);
                                resolve(stats);
                            }
                        });
                        return;
                    }

                    const tweet = tweets[index];

                    // 检查推文是否已存在
                    checkStmt.get(tweet.id, (err, existingTweet) => {
                        if (err) {
                            logger.error(`检查推文 ${tweet.id} 时出错: ${err.message}`);
                            stats.error++;
                            processTweets(index + 1);
                            return;
                        }

                        try {
                            if (existingTweet) {
                                // 检查是否有数据变化
                                const hasChanged =
                                    existingTweet.retweet_count !== tweet.retweet_count ||
                                    existingTweet.like_count !== tweet.like_count ||
                                    existingTweet.reply_count !== tweet.reply_count ||
                                    existingTweet.quote_count !== tweet.quote_count ||
                                    existingTweet.bookmark_count !== tweet.bookmark_count ||
                                    existingTweet.view_count !== tweet.view_count;

                                if (hasChanged) {
                                    // 如果有变化，只更新计数器字段
                                    updateStmt.run(
                                        tweet.retweet_count,
                                        tweet.like_count,
                                        tweet.reply_count,
                                        tweet.quote_count,
                                        tweet.bookmark_count,
                                        tweet.view_count,
                                        now,
                                        tweet.id,
                                        (err) => {
                                            if (err) {
                                                logger.error(`更新推文 ${tweet.id} 时出错: ${err.message}`);
                                                stats.error++;
                                            } else {
                                                stats.updated++;
                                                if (stats.updated <= 3) {
                                                    logger.debug(`更新推文 ${tweet.id}：交互数据变化`);
                                                }
                                            }
                                            processTweets(index + 1);
                                        }
                                    );
                                } else {
                                    // 没有变化，跳过
                                    stats.skipped++;
                                    processTweets(index + 1);
                                }
                            } else {
                                // 新推文，执行插入
                                insertStmt.run(
                                    tweet.id,
                                    tweet.user_id,
                                    tweet.username,
                                    tweet.screen_name,
                                    tweet.text,
                                    tweet.created_at,
                                    tweet.retweet_count,
                                    tweet.like_count,
                                    tweet.reply_count,
                                    tweet.quote_count,
                                    tweet.bookmark_count,
                                    tweet.view_count,
                                    now,
                                    tweet.media_urls,
                                    (err) => {
                                        if (err) {
                                            logger.error(`插入推文 ${tweet.id} 时出错: ${err.message}`);
                                            stats.error++;
                                        } else {
                                            stats.new++;
                                            if (stats.new <= 3) {
                                                logger.debug(`新增推文 ${tweet.id}：${tweet.text.substring(0, 30)}...`);
                                            }
                                        }
                                        processTweets(index + 1);
                                    }
                                );
                            }
                        } catch (err) {
                            logger.error(`处理推文 ${tweet.id} 时出错: ${err.message}`);
                            stats.error++;
                            processTweets(index + 1);
                        }
                    });
                };

                // 开始处理第一条推文
                processTweets(0);
            });
        });
    }

    /**
     * 添加或更新用户信息
     * @param {Object} user - 用户信息对象
     * @returns {Promise<Object>} 操作结果
     */
    async saveUser(user) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                logger.error('数据库未连接');
                return reject(new Error('数据库未连接'));
            }

            const now = new Date().toISOString();

            // 检查用户是否存在
            this.db.get('SELECT id FROM users WHERE id = ?', [user.id], (err, row) => {
                if (err) {
                    logger.error(`检查用户记录时出错: ${err.message}`);
                    return reject(err);
                }

                if (row) {
                    // 更新现有用户
                    this.db.run(`
                        UPDATE users SET
                            username = ?,
                            screen_name = ?,
                            name = ?,
                            description = ?,
                            followers_count = ?,
                            following_count = ?,
                            tweet_count = ?,
                            profile_image_url = ?,
                            is_following = ?,
                            is_tracked = ?,
                            last_updated = ?
                        WHERE id = ?
                    `, [
                        user.username || '',
                        user.screen_name || '',
                        user.name || '',
                        user.description || '',
                        user.followers_count || 0,
                        user.following_count || 0,
                        user.tweet_count || 0,
                        user.profile_image_url || '',
                        user.is_following || 0,
                        user.is_tracked || 0,
                        now,
                        user.id
                    ], function (err) {
                        if (err) {
                            logger.error(`更新用户 ${user.id} 时出错: ${err.message}`);
                            return reject(err);
                        }
                        logger.info(`已更新用户: ${user.screen_name || user.id}`);
                        resolve({ updated: true, id: user.id });
                    });
                } else {
                    // 添加新用户
                    this.db.run(`
                        INSERT INTO users (
                            id, username, screen_name, name, description,
                            followers_count, following_count, tweet_count,
                            profile_image_url, is_following, is_tracked, last_updated
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        user.id,
                        user.username || '',
                        user.screen_name || '',
                        user.name || '',
                        user.description || '',
                        user.followers_count || 0,
                        user.following_count || 0,
                        user.tweet_count || 0,
                        user.profile_image_url || '',
                        user.is_following || 0,
                        user.is_tracked || 0,
                        now
                    ], function (err) {
                        if (err) {
                            logger.error(`添加用户 ${user.id} 时出错: ${err.message}`);
                            return reject(err);
                        }
                        logger.info(`已添加新用户: ${user.screen_name || user.id}`);
                        resolve({ inserted: true, id: user.id });
                    });
                }
            });
        });
    }

    /**
     * 获取要跟踪的用户列表
     * @returns {Promise<Array>} 用户对象数组
     */
    async getTrackedUsers() {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                logger.error('数据库未连接');
                return reject(new Error('数据库未连接'));
            }

            this.db.all(`
                SELECT id, username, screen_name
                FROM users
                WHERE is_tracked = 1
                ORDER BY screen_name
            `, [], (err, rows) => {
                if (err) {
                    logger.error(`获取跟踪用户列表失败: ${err.message}`);
                    return reject(err);
                }

                logger.info(`从数据库获取到 ${rows.length} 个跟踪用户`);
                resolve(rows);
            });
        });
    }

    /**
     * 从CSV文件加载用户列表
     * @returns {Set<string>} 用户名集合
     */
    loadUsersFromCsv() {
        const usernames = new Set();

        try {
            // 首先尝试从数据库获取要跟踪的用户
            this.getTrackedUsers()
                .then(users => {
                    if (users && users.length > 0) {
                        users.forEach(user => {
                            if (user.screen_name) {
                                usernames.add(user.screen_name);
                            }
                        });
                        logger.info(`从数据库加载了 ${usernames.size} 个跟踪用户`);
                        return;
                    }

                    // 如果数据库中没有用户，则回退到CSV文件
                    if (!fs.existsSync(CONFIG.USERS_CSV_PATH)) {
                        logger.warn(`找不到文件: ${CONFIG.USERS_CSV_PATH}，数据库中也没有跟踪用户`);
                        return;
                    }

                    const csvContent = fs.readFileSync(CONFIG.USERS_CSV_PATH, 'utf-8');
                    const lines = csvContent.trim().split('\n');

                    // 跳过标题行，获取所有唯一的用户名
                    for (let i = 1; i < lines.length; i++) {
                        const line = lines[i].split(',');
                        if (line[0]) { // 假设第一列是用户名
                            usernames.add(line[0].trim());
                        }
                    }
                    logger.info(`从CSV文件加载了 ${usernames.size} 个用户`);
                })
                .catch(err => {
                    logger.error(`从数据库加载用户失败，尝试使用CSV: ${err.message}`);

                    // 回退到CSV文件
                    if (!fs.existsSync(CONFIG.USERS_CSV_PATH)) {
                        logger.error(`找不到文件: ${CONFIG.USERS_CSV_PATH}`);
                        return;
                    }

                    const csvContent = fs.readFileSync(CONFIG.USERS_CSV_PATH, 'utf-8');
                    const lines = csvContent.trim().split('\n');

                    // 跳过标题行，获取所有唯一的用户名
                    for (let i = 1; i < lines.length; i++) {
                        const line = lines[i].split(',');
                        if (line[0]) { // 假设第一列是用户名
                            usernames.add(line[0].trim());
                        }
                    }
                });
        } catch (error) {
            logger.error(`读取用户列表出错: ${error.message}`);
        }

        return usernames;
    }

    /**
     * 获取数据库中的所有用户
     * @returns {Promise<Array>} 用户对象数组
     */
    async getAllUsers() {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                logger.error('数据库未连接');
                return reject(new Error('数据库未连接'));
            }

            const query = `
                SELECT 
                    id, 
                    username, 
                    screen_name, 
                    name, 
                    description, 
                    followers_count, 
                    following_count, 
                    tweet_count, 
                    profile_image_url, 
                    is_following, 
                    is_tracked, 
                    last_updated
                FROM users
                ORDER BY screen_name ASC
            `;

            this.db.all(query, [], (err, rows) => {
                if (err) {
                    logger.error(`获取所有用户失败: ${err.message}`);
                    return reject(err);
                }

                logger.info(`从数据库获取到 ${rows.length} 条用户记录`);
                resolve(rows);
            });
        });
    }
}

// 导出类和常量
module.exports = {
    DatabaseManager,
    CONFIG
}; 