/**
 * 集中式日志记录模块
 * 
 * 功能：
 * - 为不同组件创建独立的日志记录器
 * - 支持控制台和文件双重输出
 * - 日志文件自动轮换和大小限制
 * - 错误日志单独记录
 * - 完整的堆栈跟踪支持
 * 
 * @module logger
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// ==================== 配置常量 ====================

/**
 * 日志目录路径
 * @constant {string}
 */
const LOG_DIR = 'logs';

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * 日志级别定义
 * @constant {Object}
 */
const LOG_LEVELS = {
    error: 0,      // 错误信息
    warn: 1,       // 警告信息
    info: 2,       // 一般信息
    http: 3,       // HTTP 请求
    verbose: 4,    // 详细信息
    debug: 5,      // 调试信息
    silly: 6       // 极详细信息
};

// ==================== 日志格式配置 ====================

/**
 * 文件日志格式（包含完整时间戳和堆栈跟踪）
 * @constant {winston.Logform.Format}
 */
const defaultFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, stack, component }) => {
        const componentStr = component ? `[${component}]` : '';
        const stackTrace = stack ? `\n${stack}` : '';
        return `${timestamp} ${level.toUpperCase()} ${componentStr}: ${message}${stackTrace}`;
    })
);

/**
 * 控制台日志格式（彩色输出，简化时间戳）
 * @constant {winston.Logform.Format}
 */
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp, component }) => {
        const componentStr = component ? `[${component}]` : '';
        return `${timestamp} ${level} ${componentStr}: ${message}`;
    })
);

// ==================== 日志记录器工厂 ====================

/**
 * 创建组件专用的日志记录器
 * 
 * @param {string} component - 组件名称（如 'spider', 'database', 'summary'）
 * @param {Object} [options={}] - 配置选项
 * @param {string} [options.level] - 日志级别（默认：info）
 * @param {boolean} [options.enableConsole=true] - 是否启用控制台输出
 * @param {boolean} [options.enableFile=true] - 是否启用文件输出
 * @param {number} [options.maxSize=5242880] - 单个日志文件最大大小（字节，默认5MB）
 * @param {number} [options.maxFiles=5] - 保留的日志文件数量
 * @returns {winston.Logger} Winston 日志记录器实例
 */
function createLogger(component, options = {}) {
    const {
        level = process.env.LOG_LEVEL || 'info',
        enableConsole = true,
        enableFile = true,
        maxSize = 5242880,  // 5MB
        maxFiles = 5
    } = options;

    const transports = [];

    // 添加控制台传输器
    if (enableConsole) {
        transports.push(
            new winston.transports.Console({
                level,
                format: consoleFormat
            })
        );
    }

    // 添加组件专用文件传输器
    if (enableFile) {
        const filename = component ? `${component}.log` : 'app.log';
        transports.push(
            new winston.transports.File({
                filename: path.join(LOG_DIR, filename),
                level,
                format: defaultFormat,
                maxsize: maxSize,
                maxFiles,
                tailable: true
            })
        );
    }

    // 添加错误日志专用传输器（所有组件的错误都记录到同一文件）
    if (enableFile) {
        transports.push(
            new winston.transports.File({
                filename: path.join(LOG_DIR, 'error.log'),
                level: 'error',
                format: defaultFormat,
                maxsize: maxSize,
                maxFiles,
                tailable: true
            })
        );
    }

    return winston.createLogger({
        levels: LOG_LEVELS,
        level,
        defaultMeta: { component },
        transports
    });
}

// ==================== 模块导出 ====================

/**
 * 默认日志记录器（用于应用级别的日志）
 * @constant {winston.Logger}
 */
const defaultLogger = createLogger('app');

module.exports = {
    createLogger,
    defaultLogger,
    LOG_LEVELS
}; 