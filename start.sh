#!/bin/bash

# 启动 Node.js 应用程序并在后台运行
nohup npm start > app_output.log 2>&1 &

echo "应用程序已在后台启动，输出日志记录在 app_output.log"
