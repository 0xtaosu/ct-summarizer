# CT Summarizer

一个用于收集、处理和分析 Twitter/X 数据的 Node.js 应用程序，支持 AI 智能总结和 Web 展示。

## 系统概览

本系统自动从 Twitter/X 收集数据，利用 AI 生成智能摘要，并通过简洁美观的 Web 界面呈现分析结果。

## 系统组件

本系统包含以下主要组件：

1. **数据采集服务 (spider.js)**
   - 通过 KooSocial API 获取 Twitter/X 数据
   - 自动定时从数据库中的用户获取最新推文
   - 支持手动获取特定账号的关注者列表(支持分页获取大量关注)
   - 数据自动存储到 SQLite 数据库
   - 支持定时采集推文，默认每小时执行一次

2. **AI 总结与 Web 界面 (index.js)**
   - 处理存储的推文数据
   - 使用 DeepSeek API 生成智能摘要
   - 提供简洁美观的 Web 界面展示摘要
   - 支持一键获取最新总结
   - 支持查看原始推文来源

3. **数据库管理模块 (data.js)**
   - 处理所有数据库操作
   - 管理推文和用户数据
   - 支持高效的时间范围查询

4. **配置模块 (config.js)**
   - 集中管理 AI 提示词配置
   - 管理应用程序参数设置

## 安装与配置

### 环境要求

- Node.js v14.0.0 或更高版本
- npm 或 yarn
- SQLite3

### 安装步骤

1. 克隆项目仓库：
   ```
   git clone <仓库地址>
   cd ct-summarizer
   ```

2. 安装依赖：
   ```
   npm install
   ```

3. 创建配置文件：
   ```
   cp .env.example .env
   ```

4. 修改配置文件 `.env`，填入必要的 API 密钥：
   ```
   KOOSOCIAL_API_KEY=your_api_key_here
   DEEPSEEK_API_KEY=your_api_key_here
   PORT=5001  # 可选，默认为 5001
   ```

## 使用方法

### 启动系统

使用提供的脚本一键启动所有服务：

```
./start.sh
```

或分开启动各个服务：

```
# 启动爬虫服务
node spider.js

# 启动 Web 服务
node index.js
```

### 停止系统

```
./stop.sh
```

### 查看状态

```
./status.sh
```

### 命令行选项

#### 数据采集服务 (spider.js)

- 测试模式（获取所有用户的推文但不设置定时任务）：
  ```
  node spider.js --test
  ```

- 手动获取关注列表（用于更新要跟踪的用户列表）：
  ```
  node spider.js --fetch-followings
  ```

- 手动获取指定账号的关注列表：
  ```
  node spider.js --fetch-followings --user <Twitter用户名>
  ```

- 手动获取指定账号的关注列表（使用数字 ID）：
  ```
  node spider.js --fetch-followings --userid <Twitter用户ID>
  ```

#### Web 服务 (index.js)

- 指定端口：
  ```
  node index.js --port 3000
  ```

## Web 界面使用

启动服务后，访问 `http://localhost:5001`（或您配置的端口）即可看到 Web 界面：

1. 点击「获取最近1小时总结」按钮获取最新总结
2. 系统将通过 DeepSeek AI 分析最近一小时的推文数据
3. 呈现分析结果，包括市场概览和热门代币/项目分析
4. 点击「来源」链接可查看原始推文

## 数据存储

系统使用 SQLite 作为数据库，存储在 `data/twitter_data.db` 文件中。数据库包含以下主要表：

1. **tweets**: 存储采集的推文数据
2. **users**: 存储用户资料信息，包括要跟踪的所有 Twitter 用户

## 自定义配置

### 修改 AI 提示词

编辑 `config.js` 文件中的 `SYSTEM_PROMPT` 变量可以自定义 AI 生成摘要的提示词。

### 修改 Web 界面

编辑 `public/index.html` 文件可以自定义 Web 界面的样式和功能。

## 项目架构

```
.
├── data/                  # 数据存储目录
│   └── twitter_data.db    # SQLite 数据库
├── public/                # 静态资源文件
│   └── index.html         # Web 界面
├── spider.js              # 数据采集服务
├── index.js               # Web 服务和数据处理
├── data.js                # 数据库管理模块
├── config.js              # 配置模块
├── start.sh               # 启动脚本
├── stop.sh                # 停止脚本
├── status.sh              # 状态查看脚本
└── README.md              # 说明文档
```

## 日志

系统各组件生成的日志保存在以下文件中：

- `spider.log`: 数据采集服务日志
- `database.log`: 数据库操作日志
- `app.log`: Web 服务日志

## 许可协议

Copyright © 2024