# CT Summarizer

一个用于收集、处理和分析 Twitter 数据的 Node.js 应用程序。

## 系统组件

本系统包含以下主要组件：

1. **数据采集服务 (spider.js)**
   - 自动定时从数据库中的用户获取最新推文
   - 支持手动获取特定账号的关注者列表(支持分页获取大量关注)
   - 数据自动存储到SQLite数据库
   - 支持定时采集推文，默认每小时执行一次

2. **数据处理与Web界面 (index.js)**
   - 处理存储的推文数据
   - 使用DeepSeek API生成AI摘要
   - 提供Web界面展示推文和摘要

3. **数据库管理模块 (data.js)**
   - 处理所有数据库操作
   - 管理推文和用户数据

## 安装与配置

### 环境要求

- Node.js v14.0.0 或更高版本
- npm 或 yarn

### 安装步骤

1. 克隆项目仓库：
   ```
   git clone <仓库地址>
   cd twitter-data-collector
   ```

2. 安装依赖：
   ```
   npm install
   ```

3. 创建配置文件：
   ```
   cp .env.example .env
   ```

4. 修改配置文件 `.env`，填入必要的API密钥：
   ```
   KOOSOCIAL_API_KEY=your_api_key_here
   DEEPSEEK_API_KEY=your_api_key_here
   FOLLOWER_SOURCE_ACCOUNT=your_source_account_here
   ```

## 使用方法

### 启动系统

使用提供的脚本一键启动所有服务：

```
./start.sh
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

- 手动获取指定账号的关注列表（使用用户名）：
  ```
  node spider.js --fetch-followings --user <Twitter用户名>
  ```

- 手动获取指定账号的关注列表（使用数字ID）：
  ```
  node spider.js --fetch-followings --userid <Twitter用户ID>
  ```

  > 注意：Twitter API每次请求最多返回70个关注账号，系统会自动处理分页以获取所有关注账号。
  > 分页处理逻辑：系统解析API响应顶层的cursor对象，当bottom值格式为"0|数字"（即"|"前为0）时，表示已到达最后一页。

#### Web服务 (index.js)

- 指定端口：
  ```
  node index.js --port 3000
  ```

## 数据存储

系统使用SQLite作为数据库，存储在`data/twitter_data.db`文件中。数据库包含以下主要表：

1. **tweets**: 存储采集的推文数据
2. **users**: 存储用户资料信息，包括要跟踪的所有Twitter用户

## 用户跟踪与数据收集流程

系统采用以下工作流程处理Twitter数据：

1. **用户管理（手动操作）**
   - 通过 `--fetch-followings` 命令手动更新要跟踪的用户列表
   - 系统从数据库中获取用户信息，而不再使用CSV文件

2. **推文收集（自动定时操作）**
   - 系统启动时立即从数据库中所有用户获取最新推文
   - 每小时自动执行一次推文获取任务
   - 所有推文数据自动保存到数据库中

## Twitter API游标说明

Twitter分页API使用特殊的游标格式来控制数据分页。游标通常是形如 "X|Y" 的字符串，其中：
- 当X为0时（例如 "0|123456789"），表示这是最后一页数据，没有更多后续页面
- 当X不为0时，表示还有更多数据可以获取
- Y部分是内部使用的标识符

本系统自动处理这种游标格式，确保能够正确获取所有页面的数据。

## 项目架构

```
.
├── data/                  # 数据存储目录
│   └── twitter_data.db    # SQLite数据库
├── public/                # 静态资源文件
├── spider.js              # 数据采集服务
├── index.js               # Web服务和数据处理
├── data.js                # 数据库管理模块
├── start.sh               # 启动脚本
├── stop.sh                # 停止脚本
├── status.sh              # 状态查看脚本
└── README.md              # 说明文档
```

## 日志

系统各组件生成的日志保存在以下文件中：

- `spider.log`: 数据采集服务日志
- `database.log`: 数据库操作日志
- `app.log`: Web服务日志
- `webhook.log`: Webhook事件日志

## 许可协议

Copyright © 2024