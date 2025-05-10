#!/bin/bash

echo "===== Twitter 数据采集和分析系统状态 ====="
echo "检查时间: $(date)"
echo ""

# 检查数据采集器状态
echo "数据采集器 (spider.js):"
if [ -f "logs/spider.pid" ]; then
    SPIDER_PID=$(cat logs/spider.pid)
    if ps -p $SPIDER_PID > /dev/null; then
        echo "  状态: 运行中 (PID: $SPIDER_PID)"
        UPTIME=$(ps -o etime= -p $SPIDER_PID)
        echo "  运行时间: $UPTIME"
        MEM=$(ps -o %mem= -p $SPIDER_PID | tr -d ' ')
        echo "  内存使用: $MEM%"
    else
        echo "  状态: 已停止 (PID文件存在但进程不存在)"
    fi
else
    echo "  状态: 未运行 (找不到PID文件)"
fi

# 显示最近的数据采集器日志
if [ -f "logs/spider.log" ]; then
    echo "  最近日志:"
    echo "  ------------------------------------------------"
    tail -n 5 logs/spider.log | sed 's/^/  /'
    echo "  ------------------------------------------------"
else
    echo "  日志文件不存在"
fi
echo ""

# 检查Web服务状态
echo "Web服务 (index.js):"
if [ -f "logs/index.pid" ]; then
    INDEX_PID=$(cat logs/index.pid)
    if ps -p $INDEX_PID > /dev/null; then
        echo "  状态: 运行中 (PID: $INDEX_PID)"
        UPTIME=$(ps -o etime= -p $INDEX_PID)
        echo "  运行时间: $UPTIME"
        MEM=$(ps -o %mem= -p $INDEX_PID | tr -d ' ')
        echo "  内存使用: $MEM%"
        # 检查端口是否在监听
        PORT=${PORT:-5001}
        if netstat -tuln 2>/dev/null | grep -q ":$PORT "; then
            echo "  Web端口: $PORT (正在监听)"
        else
            echo "  Web端口: $PORT (未监听)"
        fi
    else
        echo "  状态: 已停止 (PID文件存在但进程不存在)"
    fi
else
    echo "  状态: 未运行 (找不到PID文件)"
fi

# 显示最近的Web服务日志
if [ -f "logs/index.log" ]; then
    echo "  最近日志:"
    echo "  ------------------------------------------------"
    tail -n 5 logs/index.log | sed 's/^/  /'
    echo "  ------------------------------------------------"
else
    echo "  日志文件不存在"
fi
echo ""

# 检查数据库文件状态
DB_FILE="data/twitter_data.db"
echo "数据库状态:"
if [ -f "$DB_FILE" ]; then
    SIZE=$(du -h "$DB_FILE" | cut -f1)
    LAST_MODIFIED=$(stat -c %y "$DB_FILE" 2>/dev/null || stat -f "%Sm" "$DB_FILE" 2>/dev/null)
    echo "  数据库文件: $DB_FILE"
    echo "  文件大小: $SIZE"
    echo "  最后修改: $LAST_MODIFIED"
else
    echo "  数据库文件不存在: $DB_FILE"
fi
echo ""

echo "===== 系统状态检查完成 ====="
echo ""
echo "查看完整日志:"
echo "  数据采集器: tail -f logs/spider.log"
echo "  Web服务: tail -f logs/index.log"
echo "" 