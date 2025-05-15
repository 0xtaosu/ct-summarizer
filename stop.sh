#!/bin/bash

echo "===== 停止 Twitter 数据采集和分析系统 ====="
echo "$(date): 开始停止服务"

# 检查PID文件是否存在
if [ ! -f "logs/spider.pid" ] || [ ! -f "logs/index.pid" ]; then
    echo "警告: 找不到PID文件，服务可能未运行"
fi

# 停止数据采集器
if [ -f "logs/spider.pid" ]; then
    SPIDER_PID=$(cat logs/spider.pid)
    echo "正在停止数据采集器 (PID: $SPIDER_PID)..."
    if ps -p $SPIDER_PID > /dev/null; then
        kill $SPIDER_PID
        sleep 2
        if ps -p $SPIDER_PID > /dev/null; then
            echo "数据采集器未响应，尝试强制终止..."
            kill -9 $SPIDER_PID
            sleep 1
        fi
        echo "数据采集器已停止"
    else
        echo "数据采集器不在运行状态"
    fi
    rm -f logs/spider.pid
else
    echo "找不到数据采集器PID文件"
fi

# 停止Web服务
if [ -f "logs/index.pid" ]; then
    INDEX_PID=$(cat logs/index.pid)
    echo "正在停止Web服务 (PID: $INDEX_PID)..."
    if ps -p $INDEX_PID > /dev/null; then
        kill $INDEX_PID
        sleep 2
        if ps -p $INDEX_PID > /dev/null; then
            echo "Web服务未响应，尝试强制终止..."
            kill -9 $INDEX_PID
            sleep 1
        fi
        echo "Web服务已停止"
    else
        echo "Web服务不在运行状态"
    fi
    rm -f logs/index.pid
else
    echo "找不到Web服务PID文件"
fi

echo "===== 所有服务已停止 ====="
echo "$(date): 服务停止完成" 