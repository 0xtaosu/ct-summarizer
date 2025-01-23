# CT Summarizer

一个用于处理 Twitter 数据的 Node.js 应用程序。

## 功能特点

- 接收并处理 Twitter Webhook 数据
- 数据存储到 CSV 文件
- 定期生成数据总结
- 通过 Telegram 发送通知

## 环境要求

- Node.js >= 14.x
- npm >= 6.x

## 安装

1. 克隆仓库：
```bash
git clone https://github.com/0xtaosu/ct-summarizer.git
cd ct-agent
```

2. 安装依赖：
```bash
npm install
```

3. 配置环境变量：
创建 `.env` 文件并添加以下配置：
```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
XAI_API_KEY=your_xai_api_key
PORT=3000
```

## 运行

启动服务器：
```bash
npm start
```

服务器将在配置的端口上运行（默认为 3000）。

## API 端点

### POST /webhook
接收 Twitter webhook 数据的端点。

请求体示例：
```json
{
    "user_name": "example_user",
    "user_description": "User description",
    "event_type": "tweet",
    "content": "Tweet content"
}
```

## 数据存储

所有接收到的数据都会被存储在 `data/twitter_data.csv` 文件中。

## 定时任务

系统会每小时自动生成一次数据总结，并通过 Telegram 发送。

## 许可证

MIT