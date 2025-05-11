/**
 * 集中式日志记录模块
 * 
 * 该模块提供统一的日志记录功能，包括：
 * - 为不同组件提供独立的日志记录器
 * - 配置日志级别、格式和输出目标
 * - 支持日志文件轮换和大小限制
 * - 提供错误堆栈跟踪记录
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// 确保日志目录存在
const LOG_DIR = 'logs';
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * 日志级别
 * error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6
 */
const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    silly: 6
};

/**
 * 默认日志格式
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
 * 控制台输出格式
 */
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp, component }) => {
        const componentStr = component ? `[${component}]` : '';
        return `${timestamp} ${level} ${componentStr}: ${message}`;
    })
);

/**
 * 创建日志记录器
 * @param {string} component - 组件名称
 * @param {Object} options - 日志配置选项
 * @returns {winston.Logger} - Winston日志记录器实例
 */
function createLogger(component, options = {}) {
    const {
        level = process.env.LOG_LEVEL || 'info',
        enableConsole = true,
        enableFile = true,
        maxSize = 5242880, // 5MB
        maxFiles = 5
    } = options;

    const transports = [];

    // 控制台输出
    if (enableConsole) {
        transports.push(
            new winston.transports.Console({
                level,
                format: consoleFormat
            })
        );
    }

    // 文件输出
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

    // 错误日志单独保存
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

    // 创建日志记录器
    const logger = winston.createLogger({
        levels: LOG_LEVELS,
        level,
        defaultMeta: { component },
        transports
    });

    return logger;
}

/**
 * 创建默认日志记录器
 */
const defaultLogger = createLogger('app');

module.exports = {
    createLogger,
    defaultLogger,
    LOG_LEVELS
}; 