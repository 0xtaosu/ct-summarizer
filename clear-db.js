#!/usr/bin/env node

/**
 * 清除 SQLite 数据库历史数据脚本
 * 
 * 使用方法:
 *   node clear-db.js                    # 清除所有表的数据
 *   node clear-db.js --tweets          # 只清除推文数据
 *   node clear-db.js --users           # 只清除用户数据
 *   node clear-db.js --summaries       # 只清除总结数据
 *   node clear-db.js --tweets --summaries  # 清除推文和总结数据
 */

const { DatabaseManager } = require('./data');
const { createLogger } = require('./logger');

const logger = createLogger('clear-db');

// 解析命令行参数
const args = process.argv.slice(2);
const clearAll = args.length === 0;
const clearTweets = clearAll || args.includes('--tweets');
const clearUsers = clearAll || args.includes('--users');
const clearSummaries = clearAll || args.includes('--summaries');

/**
 * 获取表的记录数
 */
function getTableCount(db, tableName) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT COUNT(*) as count FROM ${tableName}`, (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row.count);
            }
        });
    });
}

/**
 * 清除表数据
 */
function clearTable(db, tableName) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM ${tableName}`, (err) => {
            if (err) {
                reject(err);
            } else {
                // 重置自增ID（仅对summaries表有效）
                if (tableName === 'summaries') {
                    db.run(`DELETE FROM sqlite_sequence WHERE name='${tableName}'`, () => {
                        resolve();
                    });
                } else {
                    resolve();
                }
            }
        });
    });
}

/**
 * 主函数
 */
async function main() {
    console.log('===== 清除 SQLite 数据库历史数据 =====\n');

    // 显示要清除的内容
    console.log('将清除以下表的数据:');
    if (clearTweets) console.log('  ✓ tweets (推文数据)');
    if (clearUsers) console.log('  ✓ users (用户数据)');
    if (clearSummaries) console.log('  ✓ summaries (总结数据)');
    console.log('');

    // 创建数据库管理器
    const dbManager = new DatabaseManager(false);

    // 等待数据库连接
    await new Promise((resolve) => {
        const checkConnection = setInterval(() => {
            if (dbManager.db) {
                clearInterval(checkConnection);
                resolve();
            }
        }, 100);
    });

    try {
        // 显示清除前的数据统计
        console.log('清除前的数据统计:');
        const tweetsBefore = clearTweets ? await getTableCount(dbManager.db, 'tweets') : 0;
        const usersBefore = clearUsers ? await getTableCount(dbManager.db, 'users') : 0;
        const summariesBefore = clearSummaries ? await getTableCount(dbManager.db, 'summaries') : 0;

        if (clearTweets) console.log(`  tweets: ${tweetsBefore} 条记录`);
        if (clearUsers) console.log(`  users: ${usersBefore} 条记录`);
        if (clearSummaries) console.log(`  summaries: ${summariesBefore} 条记录`);
        console.log('');

        // 执行清除操作
        console.log('正在清除数据...');

        if (clearTweets) {
            logger.info('清除 tweets 表数据...');
            await clearTable(dbManager.db, 'tweets');
            console.log('  ✓ tweets 表已清除');
        }

        if (clearUsers) {
            logger.info('清除 users 表数据...');
            await clearTable(dbManager.db, 'users');
            console.log('  ✓ users 表已清除');
        }

        if (clearSummaries) {
            logger.info('清除 summaries 表数据...');
            await clearTable(dbManager.db, 'summaries');
            console.log('  ✓ summaries 表已清除');
        }

        // 显示清除后的数据统计
        console.log('\n清除后的数据统计:');
        const tweetsAfter = clearTweets ? await getTableCount(dbManager.db, 'tweets') : tweetsBefore;
        const usersAfter = clearUsers ? await getTableCount(dbManager.db, 'users') : usersBefore;
        const summariesAfter = clearSummaries ? await getTableCount(dbManager.db, 'summaries') : summariesBefore;

        if (clearTweets) console.log(`  tweets: ${tweetsAfter} 条记录`);
        if (clearUsers) console.log(`  users: ${usersAfter} 条记录`);
        if (clearSummaries) console.log(`  summaries: ${summariesAfter} 条记录`);

        // 显示清除的统计
        console.log('\n清除统计:');
        if (clearTweets) console.log(`  tweets: 清除了 ${tweetsBefore - tweetsAfter} 条记录`);
        if (clearUsers) console.log(`  users: 清除了 ${usersBefore - usersAfter} 条记录`);
        if (clearSummaries) console.log(`  summaries: 清除了 ${summariesBefore - summariesAfter} 条记录`);

        console.log('\n===== 数据清除完成 =====');
        logger.info('数据库历史数据清除完成');

    } catch (error) {
        console.error('\n错误: 清除数据时发生错误');
        console.error(error.message);
        logger.error(`清除数据失败: ${error.message}`);
        process.exit(1);
    } finally {
        // 关闭数据库连接
        dbManager.close();
    }
}

// 运行主函数
main().catch(error => {
    console.error('致命错误:', error);
    logger.error(`脚本执行失败: ${error.message}`);
    process.exit(1);
});

