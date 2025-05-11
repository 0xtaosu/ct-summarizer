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
// 使用新的集中式日志记录系统
const { createLogger } = require('./logger');

// 配置常量
const CONFIG = {
    DATABASE_PATH: path.join('data', 'twitter_data.db'),
    USERS_CSV_PATH: path.join('data', 'twitter_users.csv'),
    // 数据库性能设置 - 简化适合小型系统
    PRAGMA_SETTINGS: {
        'journal_mode': 'WAL',          // 使用WAL模式提高写入性能
        'synchronous': 'NORMAL',        // 适当降低同步级别
        'cache_size': 2000,             // 适合小型系统的缓存大小
        'temp_store': 'MEMORY'          // 临时表存储在内存中
    },
    // 批量操作设置
    BATCH_SIZE: 30,                     // 小型系统适合的批处理大小
    MAX_STATEMENT_CACHE: 20             // 减少预处理语句缓存大小
};

// 创建日志记录器
const logger = createLogger('database');

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
        this.statementCache = new Map(); // 缓存预处理语句
        this.statementCacheLastCleanup = Date.now();

        // 初始化数据库
        this.init();

        // 设置定期清理缓存的定时器 (每30分钟)
        setInterval(() => this.cleanupStatementCache(), 30 * 60 * 1000);
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

            // 检查数据库文件是否存在
            const dbFileExists = fs.existsSync(this.dbPath);

            // 如果在只读模式下数据库文件不存在，则报错
            if (this.readOnly && !dbFileExists) {
                throw new Error(`数据库文件 ${this.dbPath} 不存在，无法以只读模式打开`);
            }

            // 打开数据库连接
            const openMode = this.readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
            this.db = new sqlite3.Database(this.dbPath, openMode, (err) => {
                if (err) {
                    logger.error(`连接数据库失败: ${err.message}`);
                    throw err;
                }
                logger.info(`已连接到数据库: ${this.dbPath} ${this.readOnly ? '(只读模式)' : ''}`);

                // 配置性能优化PRAGMA
                this.configurePragmas();

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
     * 配置数据库性能优化参数
     * @private
     */
    configurePragmas() {
        // 应用所有PRAGMA设置
        for (const [pragma, value] of Object.entries(CONFIG.PRAGMA_SETTINGS)) {
            // 跳过只读模式下的WAL模式设置，因为它需要写入权限
            if (this.readOnly && pragma === 'journal_mode') {
                logger.info(`跳过在只读模式下设置 PRAGMA ${pragma}=${value}`);
                continue;
            }

            this.db.run(`PRAGMA ${pragma} = ${value};`, (err) => {
                if (err) {
                    logger.error(`设置PRAGMA ${pragma}=${value}失败: ${err.message}`);
                } else {
                    logger.debug(`已设置PRAGMA ${pragma}=${value}`);
                }
            });
        }
    }

    /**
     * 创建数据库表
     */
    createTables() {
        // 创建推文表
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

                // 创建索引以加速查询
                this.createIndices();

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

        // 创建summaries表，用于存储AI生成的总结
        this.db.run(`
            CREATE TABLE IF NOT EXISTS summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                period TEXT NOT NULL,
                content TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT NOT NULL,
                tweet_count INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                status TEXT DEFAULT 'success'
            )
        `, (err) => {
            if (err) {
                logger.error(`创建summaries表失败: ${err.message}`);
            } else {
                logger.info('summaries表已创建或已存在');
                // 获取总记录数
                this.db.get("SELECT COUNT(*) as count FROM summaries", (err, row) => {
                    if (err) {
                        logger.error(`获取summaries总数失败: ${err.message}`);
                    } else {
                        logger.info(`数据库共有 ${row.count} 条总结记录`);
                    }
                });
            }
        });
    }

    /**
     * 创建索引以优化查询性能
     * @private
     */
    createIndices() {
        // 用户ID索引 - 加速按用户查询推文
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_tweets_user_id ON tweets(user_id)`, (err) => {
            if (err) {
                logger.error(`创建user_id索引失败: ${err.message}`);
            } else {
                logger.debug('已创建user_id索引');
            }
        });

        // 创建时间索引 - 加速时间范围查询
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_tweets_created_at ON tweets(created_at)`, (err) => {
            if (err) {
                logger.error(`创建created_at索引失败: ${err.message}`);
            } else {
                logger.debug('已创建created_at索引');
            }
        });

        // 屏幕名称索引 - 优化用户名查询
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_screen_name ON users(screen_name)`, (err) => {
            if (err) {
                logger.error(`创建screen_name索引失败: ${err.message}`);
            } else {
                logger.debug('已创建screen_name索引');
            }
        });

        // 总结表索引 - 优化按时间段查询
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_summaries_period ON summaries(period)`, (err) => {
            if (err) {
                logger.error(`创建summaries_period索引失败: ${err.message}`);
            } else {
                logger.debug('已创建summaries_period索引');
            }
        });

        // 总结表时间索引 - 优化按生成时间查询
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_summaries_created_at ON summaries(created_at)`, (err) => {
            if (err) {
                logger.error(`创建summaries_created_at索引失败: ${err.message}`);
            } else {
                logger.debug('已创建summaries_created_at索引');
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

        return new Promise((resolve, reject) => {
            // 首先将所有推文按批次分组处理
            const BATCH_SIZE = CONFIG.BATCH_SIZE || 50; // 每批次处理的推文数
            const batches = [];

            // 分批
            for (let i = 0; i < tweets.length; i += BATCH_SIZE) {
                batches.push(tweets.slice(i, i + BATCH_SIZE));
            }

            logger.debug(`将 ${tweets.length} 条推文分成 ${batches.length} 个批次处理`);

            // 处理单个批次的函数
            const processBatch = async (batch) => {
                return new Promise((resolveBatch, rejectBatch) => {
                    let checkStmt, insertStmt, updateStmt;

                    try {
                        // 准备语句
                        checkStmt = this.db.prepare('SELECT id, retweet_count, like_count, reply_count, quote_count, bookmark_count, view_count FROM tweets WHERE id = ?');
                        insertStmt = this.db.prepare(`
                            INSERT INTO tweets (
                                id, user_id, username, screen_name, text, created_at,
                                retweet_count, like_count, reply_count, quote_count,
                                bookmark_count, view_count, collected_at, media_urls
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `);
                        updateStmt = this.db.prepare(`
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

                        // 开始事务
                        this.db.run('BEGIN TRANSACTION', async (beginErr) => {
                            if (beginErr) {
                                logger.error(`开始事务失败: ${beginErr.message}`);
                                safeFinalize(checkStmt);
                                safeFinalize(insertStmt);
                                safeFinalize(updateStmt);
                                return rejectBatch(beginErr);
                            }

                            try {
                                // 使用Promise.all处理批次中的所有推文
                                const processPromises = batch.map(tweet =>
                                    new Promise((resolveTweet) => {
                                        // 包装在Promise中以避免异常中断批处理
                                        try {
                                            // 检查推文是否存在
                                            checkStmt.get(tweet.id, (err, existingTweet) => {
                                                if (err) {
                                                    logger.error(`检查推文 ${tweet.id} 时出错: ${err.message}`);
                                                    stats.error++;
                                                    resolveTweet();
                                                    return;
                                                }

                                                if (existingTweet) {
                                                    // 检查是否有变化
                                                    const hasChanged =
                                                        existingTweet.retweet_count !== tweet.retweet_count ||
                                                        existingTweet.like_count !== tweet.like_count ||
                                                        existingTweet.reply_count !== tweet.reply_count ||
                                                        existingTweet.quote_count !== tweet.quote_count ||
                                                        existingTweet.bookmark_count !== tweet.bookmark_count ||
                                                        existingTweet.view_count !== tweet.view_count;

                                                    if (hasChanged) {
                                                        // 更新
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
                                                                }
                                                                resolveTweet();
                                                            }
                                                        );
                                                    } else {
                                                        // 跳过
                                                        stats.skipped++;
                                                        resolveTweet();
                                                    }
                                                } else {
                                                    // 插入
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
                                                            }
                                                            resolveTweet();
                                                        }
                                                    );
                                                }
                                            });
                                        } catch (e) {
                                            logger.error(`处理推文时发生异常: ${e.message}`);
                                            stats.error++;
                                            resolveTweet();
                                        }
                                    })
                                );

                                // 等待批次中所有推文处理完成
                                await Promise.all(processPromises);

                                // 提交事务
                                this.db.run('COMMIT', (commitErr) => {
                                    if (commitErr) {
                                        logger.error(`提交事务失败: ${commitErr.message}`);
                                        this.db.run('ROLLBACK', () => {
                                            safeFinalize(checkStmt);
                                            safeFinalize(insertStmt);
                                            safeFinalize(updateStmt);
                                            rejectBatch(commitErr);
                                        });
                                    } else {
                                        safeFinalize(checkStmt);
                                        safeFinalize(insertStmt);
                                        safeFinalize(updateStmt);
                                        resolveBatch();
                                    }
                                });
                            } catch (batchError) {
                                logger.error(`批处理过程中出错: ${batchError.message}`);
                                // 回滚事务
                                this.db.run('ROLLBACK', () => {
                                    safeFinalize(checkStmt);
                                    safeFinalize(insertStmt);
                                    safeFinalize(updateStmt);
                                    rejectBatch(batchError);
                                });
                            }
                        });
                    } catch (error) {
                        logger.error(`批处理初始化出错: ${error.message}`);
                        safeFinalize(checkStmt);
                        safeFinalize(insertStmt);
                        safeFinalize(updateStmt);
                        rejectBatch(error);
                    }
                });
            };

            // 安全释放语句
            function safeFinalize(stmt) {
                if (stmt) {
                    try {
                        stmt.finalize();
                    } catch (e) {
                        logger.error(`释放语句时出错: ${e.message}`);
                    }
                }
            }

            // 依次处理各个批次 - 使用串行处理方式避免事务冲突
            const processBatches = async () => {
                try {
                    // 串行处理每个批次以避免事务冲突
                    for (let i = 0; i < batches.length; i++) {
                        const batch = batches[i];
                        logger.debug(`处理第 ${i + 1}/${batches.length} 批次，包含 ${batch.length} 条推文`);
                        // 重要: 等待每个批次完成后再处理下一个，避免事务冲突
                        await processBatch(batch);
                    }

                    logger.info(`所有批次处理完成 - 新增: ${stats.new}, 更新: ${stats.updated}, 跳过: ${stats.skipped}, 错误: ${stats.error}`);
                    resolve(stats);
                } catch (error) {
                    logger.error(`处理批次时出错: ${error.message}`);
                    reject(error);
                }
            };

            // 开始处理批次
            processBatches().catch(reject);
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

            // 从语句缓存中获取预处理语句或创建新的
            let checkStmt = this.statementCache.get('checkUser');
            if (!checkStmt) {
                checkStmt = this.db.prepare('SELECT id FROM users WHERE id = ?');
                this.statementCache.set('checkUser', checkStmt);
            }

            // 检查用户是否存在
            checkStmt.get(user.id, (err, row) => {
                if (err) {
                    logger.error(`检查用户记录时出错: ${err.message}`);
                    return reject(err);
                }

                if (row) {
                    // 更新现有用户
                    // 从语句缓存中获取预处理语句或创建新的
                    let updateStmt = this.statementCache.get('updateUser');
                    if (!updateStmt) {
                        updateStmt = this.db.prepare(`
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
                        `);
                        this.statementCache.set('updateUser', updateStmt);
                    }

                    updateStmt.run(
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
                        user.id,
                        function (err) {
                            if (err) {
                                logger.error(`更新用户 ${user.id} 时出错: ${err.message}`);
                                return reject(err);
                            }
                            logger.debug(`已更新用户: ${user.screen_name || user.id}`);
                            resolve({ updated: true, id: user.id });
                        }
                    );
                } else {
                    // 添加新用户
                    // 从语句缓存中获取预处理语句或创建新的
                    let insertStmt = this.statementCache.get('insertUser');
                    if (!insertStmt) {
                        insertStmt = this.db.prepare(`
                            INSERT INTO users (
                                id, username, screen_name, name, description,
                                followers_count, following_count, tweet_count,
                                profile_image_url, is_following, is_tracked, last_updated
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `);
                        this.statementCache.set('insertUser', insertStmt);
                    }

                    insertStmt.run(
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
                        now,
                        function (err) {
                            if (err) {
                                logger.error(`添加用户 ${user.id} 时出错: ${err.message}`);
                                return reject(err);
                            }
                            logger.debug(`已添加新用户: ${user.screen_name || user.id}`);
                            resolve({ inserted: true, id: user.id });
                        }
                    );
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

    /**
     * 清理预处理语句缓存
     * 释放语句以减少内存占用
     */
    cleanupStatementCache() {
        try {
            // 如果缓存超过最大容量，执行清理
            if (this.statementCache.size > 0) {
                logger.debug(`清理语句缓存: 当前大小=${this.statementCache.size}`);

                // 关闭所有预处理语句
                for (const [key, stmt] of this.statementCache.entries()) {
                    try {
                        stmt.finalize();
                    } catch (e) {
                        logger.error(`清理缓存语句 '${key}' 时出错: ${e.message}`);
                    }
                }

                // 清空缓存
                this.statementCache.clear();
                this.statementCacheLastCleanup = Date.now();

                logger.debug('语句缓存已清理');
            }
        } catch (error) {
            logger.error(`清理语句缓存时出错: ${error.message}`);
        }
    }

    /**
     * 保存AI生成的总结到数据库
     * @param {string} period - 总结的时间段 (1hour, 12hours, 1day)
     * @param {string} content - 总结内容
     * @param {Date} startTime - 总结的开始时间
     * @param {Date} endTime - 总结的结束时间
     * @param {number} tweetCount - 包含的推文数量
     * @param {string} status - 状态 (success, error)
     * @returns {Promise<Object>} 操作结果
     */
    async saveSummary(period, content, startTime, endTime, tweetCount, status = 'success') {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                logger.error('数据库未连接');
                return reject(new Error('数据库未连接'));
            }

            const now = new Date().toISOString();
            const startIsoString = startTime.toISOString();
            const endIsoString = endTime.toISOString();

            this.db.run(`
                INSERT INTO summaries (
                    period, content, start_time, end_time, 
                    tweet_count, created_at, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
                period,
                content,
                startIsoString,
                endIsoString,
                tweetCount,
                now,
                status
            ], function (err) {
                if (err) {
                    logger.error(`保存总结失败: ${err.message}`);
                    return reject(err);
                }

                logger.info(`已成功保存${period}总结 (ID: ${this.lastID})`);
                resolve({
                    id: this.lastID,
                    period,
                    tweetCount,
                    created_at: now
                });
            });
        });
    }

    /**
     * 获取最新的总结
     * @param {string} period - 时间段 (1hour, 12hours, 1day)
     * @returns {Promise<Object>} 总结对象
     */
    async getLatestSummary(period) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                logger.error('数据库未连接');
                return reject(new Error('数据库未连接'));
            }

            this.db.get(`
                SELECT 
                    id, period, content, start_time, end_time, 
                    tweet_count, created_at, status
                FROM summaries
                WHERE period = ? AND status = 'success'
                ORDER BY created_at DESC
                LIMIT 1
            `, [period], (err, row) => {
                if (err) {
                    logger.error(`获取${period}最新总结失败: ${err.message}`);
                    return reject(err);
                }

                if (!row) {
                    logger.warn(`未找到${period}的总结记录`);
                    return resolve(null);
                }

                logger.info(`获取到${period}最新总结 (ID: ${row.id}, 创建时间: ${row.created_at})`);
                resolve(row);
            });
        });
    }

    /**
     * 获取指定时间段的所有总结
     * @param {string} period - 时间段 (1hour, 12hours, 1day)
     * @param {number} limit - 限制返回数量
     * @returns {Promise<Array>} 总结对象数组
     */
    async getSummaryHistory(period, limit = 10) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                logger.error('数据库未连接');
                return reject(new Error('数据库未连接'));
            }

            this.db.all(`
                SELECT 
                    id, period, content, start_time, end_time, 
                    tweet_count, created_at, status
                FROM summaries
                WHERE period = ?
                ORDER BY created_at DESC
                LIMIT ?
            `, [period, limit], (err, rows) => {
                if (err) {
                    logger.error(`获取${period}总结历史失败: ${err.message}`);
                    return reject(err);
                }

                logger.info(`获取到${rows.length}条${period}总结历史记录`);
                resolve(rows);
            });
        });
    }
}

// 导出模块
module.exports = {
    DatabaseManager,
    CONFIG
}; 