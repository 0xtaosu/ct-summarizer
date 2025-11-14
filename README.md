# CT Summarizer

一个用于收集、处理和分析 Twitter/X 数据的 Node.js 应用程序，支持 AI 智能总结和 Web 展示。

## 系统概览

本系统自动从 Twitter/X 收集数据，利用 AI 生成智能摘要，并通过简洁美观的 Web 界面呈现分析结果。系统会定期自动生成不同时间段的总结，并支持按需立即生成。

## 系统组件

本系统包含以下主要组件：

1. **数据采集服务 (spider.js)**
   - 通过 RapidAPI Twitter241 API 获取 Twitter/X 数据
   - 自动定时从数据库中的用户获取最新推文
   - 支持手动获取特定账号的关注者列表(支持分页获取大量关注)
   - 数据自动存储到 SQLite 数据库
   - 支持定时采集推文，默认每小时执行一次

2. **AI 总结与 Web 界面 (index.js)**
   - 定期处理存储的推文数据：
     - 每小时的整点过后10分钟（如1:10, 2:10）生成整点小时报告（基于上一个整点到上上个整点的数据，如 10:00-11:00）
     - 每12小时（0:10和12:10）生成12小时报告（基于前12个整点小时的数据） 
     - 每24小时（0:10）生成24小时报告（基于前24个整点小时的数据）
     - 系统启动时立即生成所有时间段的总结
   - 使用 Google Gemini API 生成智能摘要
   - 提供简洁美观的 Web 界面展示摘要
   - 支持不同时间段（整点小时、12小时、24小时）的总结查看
   - 提供历史报告时间线列表，按时间段和日期分类
   - 总结结果存储在数据库中，避免重复生成
   - 支持手动触发刷新生成新总结

3. **数据库管理模块 (data.js)**
   - 处理所有数据库操作
   - 管理推文、用户数据和总结内容
   - 支持高效的时间范围查询
   - 优化的数据库性能设置

4. **配置模块 (config.js)**
   - 集中管理 AI 提示词配置
   - 管理应用程序参数设置

5. **日志模块 (logger.js)**
   - 提供集中式日志记录
   - 支持按组件分类的日志文件

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
   cp env.example .env
   ```

4. 修改配置文件 `.env`，填入必要的 API 密钥：
   ```
   RAPIDAPI_KEY=your_rapidapi_key_here
   GEMINI_API_KEY=your_gemini_api_key_here
   PORT=5001  # 可选，默认为 5000
   ```
   
   **获取 API 密钥：**
   - **RapidAPI Key**: 访问 [RapidAPI Twitter241](https://rapidapi.com/rphrp1985/api/twitter241) 注册并订阅以获取密钥
   - **Gemini API Key**: 访问 [Google AI Studio](https://ai.google.dev/) 获取免费的 Gemini API 密钥

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

- 导出关注列表为CSV文件：
  ```
  node spider.js --export-followings
  ```
  
  默认导出到 `data/twitter_followings_export.csv`
  
  CSV文件包含以下字段：
  - `id`: 用户ID
  - `username`: 用户显示名称
  - `screen_name`: Twitter用户名（@后面的名称）
  - `name`: 用户名称
  - `description`: 用户简介
  - `followers_count`: 粉丝数
  - `following_count`: 关注数
  - `tweet_count`: 推文数
  - `profile_image_url`: 头像URL
  - `is_following`: 是否正在关注
  - `is_tracked`: 是否正在跟踪
  - `last_updated`: 最后更新时间

- 导出关注列表到指定路径：
  ```
  node spider.js --export-followings --output /path/to/output.csv
  ```

- 获取Twitter列表的推文：
  ```
  node spider.js --fetch-list --list-id <列表ID>
  ```
  
  例如：
  ```
  node spider.js --fetch-list --list-id 78468360
  ```
  
  可选参数 `--count` 指定获取数量（默认100）：
  ```
  node spider.js --fetch-list --list-id 78468360 --count 50
  ```

#### Web 服务 (index.js)

- 指定端口：
  ```
  node index.js --port 3000
  ```

## Web 界面使用

启动服务后，访问 `http://localhost:5000`（或您配置的端口）即可看到 Web 界面：

1. 在页面上选择所需的时间段（整点小时、12小时或24小时）
2. 系统会自动显示该时间段的最新总结
3. 历史报告列表会显示在页面下方，按照时间段（如14:00～15:00）显示历史数据
4. 点击历史报告可直接查看对应时间段的内容，无需额外确认
5. 点击「刷新」按钮可以手动触发生成新的总结（仅显示在最新报告页面，查看历史报告时不会显示刷新按钮）
6. 总结内容包括市场概览和热点代币/项目分析，以列表形式展示
7. 点击「来源」链接可查看原始推文

## 定时总结功能

系统会根据预设的时间表自动生成总结：

- **整点小时报告**：每小时的整点过后10分钟（如1:10, 2:10）生成，数据范围为上一个整点到上上个整点（例如当前时间为12:30，则生成的是11:00～12:00的报告）
- **12小时报告**：每天的0:10和12:10生成，数据范围为前12个整点小时
- **24小时报告**：每天的0:10生成，数据范围为前24个整点小时

重要说明：
1. 每个时间段的报告只生成一次，系统启动时不会自动生成总结
2. 只有最新的报告可以通过点击"刷新"按钮进行更新，历史报告不支持更新操作

所有总结都会存储在数据库中，以便快速访问和历史记录查询。每个时间段的重复报告会在历史列表中显示，但默认只加载每个时间段的最新报告。

## 数据存储

系统使用 SQLite 作为数据库，存储在 `data/twitter_data.db` 文件中。数据库包含以下主要表：

1. **tweets**: 存储采集的推文数据
2. **users**: 存储用户资料信息，包括要跟踪的所有 Twitter 用户
3. **summaries**: 存储生成的各时间段总结内容

## 系统架构和优化

本系统采用模块化设计，主要组件之间职责明确：

1. **并发控制**：使用请求节流管理API调用，避免系统过载
2. **错误处理**：完善的错误捕获和重试机制
3. **自动恢复**：在总结生成失败时自动记录并提供友好提示
4. **超时管理**：解决长时间运行请求的超时问题
5. **性能优化**：数据库查询优化和连接池管理

## 自定义配置

### 修改 AI 提示词

编辑 `config.js` 文件中的 `SYSTEM_PROMPT` 变量可以自定义 AI 生成摘要的提示词。系统现在使用带层级缩进的列表格式（而非表格）来呈现代币/项目分析，这样的显示方式更加清晰简洁。

### 修改 Web 界面

编辑 `public/index.html` 文件可以自定义 Web 界面的样式和功能。历史报告列表的样式可以通过调整CSS实现更多自定义效果。

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
├── logger.js              # 日志记录模块
├── start.sh               # 启动脚本
├── stop.sh                # 停止脚本
├── status.sh              # 状态查看脚本
├── env.example            # 环境变量示例文件
└── README.md              # 说明文档
```

## 日志

系统各组件生成的日志保存在以下文件中：

- `logs/summary.log`: 总结生成日志
- `logs/spider.log`: 数据采集服务日志  
- `logs/database.log`: 数据库操作日志
- `logs/app.log`: Web 服务日志
- `logs/error.log`: 错误日志

## 许可协议

Copyright © 2024