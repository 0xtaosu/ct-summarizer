#!/bin/bash

echo "===== 启动 Twitter 数据采集和分析系统 ====="
echo "$(date): 开始启动服务"

# 创建日志目录
mkdir -p logs
echo "已创建日志目录: logs/"

# 启动数据采集器 (spider.js)
echo "正在启动数据采集器 (spider.js)..."
nohup node spider.js > logs/spider.log 2>&1 &
SPIDER_PID=$!
echo "数据采集器已启动，PID: $SPIDER_PID，日志文件: logs/spider.log"

# 等待2秒确保数据采集器正常启动
sleep 2

# 检查数据采集器是否在运行
if ps -p $SPIDER_PID > /dev/null; then
    echo "数据采集器运行正常"
else
    echo "警告: 数据采集器可能未正常启动，请检查日志文件"
fi

# 启动Web服务和总结生成器 (index.js)
echo "正在启动Web服务和总结生成器 (index.js)..."
nohup node index.js > logs/index.log 2>&1 &
INDEX_PID=$!
echo "Web服务已启动，PID: $INDEX_PID，日志文件: logs/index.log"

# 等待2秒确保Web服务正常启动
sleep 2

# 检查Web服务是否在运行
if ps -p $INDEX_PID > /dev/null; then
    echo "Web服务运行正常"
else
    echo "警告: Web服务可能未正常启动，请检查日志文件"
fi

# 保存PID到文件中，以便停止脚本使用
echo $SPIDER_PID > logs/spider.pid
echo $INDEX_PID > logs/index.pid
echo "已保存进程ID到 logs/spider.pid 和 logs/index.pid"

echo "===== 所有服务已启动 ====="
echo "数据采集器 (spider.js): 每小时自动获取推文数据"
echo "Web服务 (index.js): 提供推文分析和总结访问"
echo "Web界面: http://localhost:${PORT:-5001}"
echo ""
echo "使用以下命令检查服务状态:"
echo "  - 查看数据采集器日志: tail -f logs/spider.log"
echo "  - 查看Web服务日志: tail -f logs/index.log"
echo ""
echo "使用以下命令停止服务:"
echo "  - kill \$(cat logs/spider.pid) \$(cat logs/index.pid)"
echo ""
echo "$(date): 服务启动完成"
