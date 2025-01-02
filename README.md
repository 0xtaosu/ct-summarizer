# Twitter Activity Monitor

一个用于监控和总结 Twitter 活动的 Python 应用程序。它可以接收 webhook 推送的 Twitter 数据，定期生成活动总结，并通过 Telegram 发送报告。

## 功能特点

- 接收并处理 Twitter webhook 数据
- 自动保存活动数据到 CSV 文件
- 使用 DeepSeek API 生成智能总结
- 定时生成不同时间段的活动报告：
  - 5分钟总结
  - 1小时总结
  - 6小时总结
  - 24小时总结
- 通过 Telegram 机器人发送总结报告

## 安装

1. 克隆仓库：
```
bash
git clone <repository-url>
cd twitter-activity-monitor
```


2. 安装依赖：

```
bash
pip install -r requirements.txt
```


3. 配置环境变量：
创建 `.env` 文件并添加以下配置：
```
DEEPSEEK_API_KEY=your_deepseek_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
```


## 使用方法

1. 启动服务：

```
bash
python main.py
```


2. 服务将在 `http://0.0.0.0:5000` 上运行，接收 webhook 请求

3. Webhook 端点：
- URL: `/webhook/twitter`
- 方法: POST
- 内容类型: application/json

## 数据结构

Twitter 活动数据保存在 `data/twitter_data.csv` 文件中，包含以下字段：
- timestamp: 事件发生时间
- user_name: 用户名
- event_type: 事件类型
- content: 内容

## 事件类型

支持的事件类型包括：
- new_tweet: 发布新推文
- new_description: 更新个人简介
- new_follower: 新增关注者

## 日志

- 所有活动日志保存在 `webhook.log` 文件中
- 包含请求信息、处理状态和错误信息

## 依赖项

- Flask: Web 服务器框架
- Pandas: 数据处理
- OpenAI: DeepSeek API 调用
- Schedule: 定时任务管理
- Python-telegram-bot: Telegram 机器人功能
- Python-dotenv: 环境变量管理

## 注意事项

1. 确保 `.env` 文件包含所有必要的配置
2. 保持 `data` 目录的写入权限
3. 确保网络能够访问 DeepSeek API 和 Telegram API

## 错误处理

- 所有错误都会记录在 webhook.log 文件中
- Telegram 发送失败不会影响其他功能
- 数据处理错误会返回 500 状态码

## 贡献

欢迎提交 Issue 和 Pull Request 来改进项目。

## 许可证

MIT License