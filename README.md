# CT Summarizer

一个用于收集、处理和分析 Twitter 数据的 Node.js 应用程序。

## 系统架构

该应用程序由三个主要组件组成：

1. **数据收集器 (spider.js)** - 从Twitter API获取数据并存储到数据库
2. **数据处理器 (index.js)** - 处理数据并生成AI摘要
3. **数据库管理 (data.js)** - 处理所有与数据库相关的操作

## 功能特点

- 自动收集指定Twitter账户的推文数据
- 使用DeepSeek AI模型生成内容总结
- 数据存储到SQLite数据库
- 提供Web界面查看最新总结
- 定期轮询更新数据（每小时自动执行）
- 防止数据重复并更新互动统计信息
- 便捷的管理脚本自动化运维

## 环境要求

- Node.js >= 14.x
- npm >= 6.x
- bash 或兼容的 shell 环境（用于运行管理脚本）

## 安装

1. 克隆仓库：
```bash
git clone https://github.com/0xtaosu/ct-summarizer.git
cd ct-summarizer
```

2. 安装依赖：
```bash
npm install
```

3. 创建用户列表文件:
在 `data` 目录下创建 `twitter_users.csv` 文件，格式如下：
```
username
elonmusk
vitalikbuterin
...
```

4. 配置环境变量：
创建 `.env` 文件并添加以下配置：
```
KOOSOCIAL_API_KEY=your_koosocial_api_key
DEEPSEEK_API_KEY=your_deepseek_api_key
PORT=5001
```

5. 设置脚本权限：
```bash
chmod +x start.sh stop.sh status.sh
```

## 运行

### 使用管理脚本（推荐）

启动所有服务：
```bash
./start.sh
```

查看服务状态：
```bash
./status.sh
```

停止所有服务：
```bash
./stop.sh
```

### 手动运行（单独组件）

启动数据收集器：
```bash
node spider.js
```

启动Web服务和摘要生成器：
```bash
node index.js
```

测试数据收集（一次性运行）:
```bash
node spider.js --test
```

## 访问Web界面

Web服务启动后，访问 http://localhost:5001 可以查看最新的Twitter总结。

## 系统组件详解

### data.js
中央数据管理模块，提供数据库的创建、读取、更新等功能。
- 封装所有数据库操作
- 提供读写模式和只读模式
- 支持查询特定时间范围内的推文
- 优化数据存储，避免重复数据

### spider.js
通过KooSocial API抓取Twitter数据并保存到数据库。
- 定时执行，每小时自动获取新数据
- 支持批量处理多个Twitter账户
- 自动更新互动统计（点赞、转发、评论等）
- 详细的日志记录和错误处理

### index.js
提供Web界面，使用DeepSeek AI对最近的Twitter数据进行分析和总结。
- RESTful API接口获取不同时间段的数据总结
- 响应式Web界面展示总结结果
- 使用DeepSeek AI生成有洞察力的内容分析

### 管理脚本
提供完善的系统管理功能。

#### start.sh
- 同时启动数据收集器和Web服务
- 创建日志目录结构
- 保存进程ID用于后续管理
- 验证服务启动状态

#### stop.sh
- 优雅地停止所有服务
- 处理未响应的进程
- 清理PID文件

#### status.sh
- 显示所有服务的运行状态
- 监控资源使用情况
- 显示最近的日志记录
- 检查数据库文件状态

## 数据存储

所有收集的Twitter数据存储在SQLite数据库中 (`data/twitter_data.db`)。
服务日志存储在 `logs` 目录下：
- `logs/spider.log` - 数据收集器日志
- `logs/index.log` - Web服务和AI总结日志
- `logs/database.log` - 数据库操作日志

## 常见问题

**Q: 如何添加新的Twitter账户进行跟踪？**  
A: 编辑 `data/twitter_users.csv` 文件，每行添加一个Twitter用户名，然后重启服务。

**Q: 如何修改数据采集频率？**  
A: 在 `spider.js` 中修改 `SPIDER_CONFIG.POLL_INTERVAL` 配置项，默认为每小时执行一次。

**Q: Web界面无法访问怎么办？**  
A: 运行 `./status.sh` 检查服务状态，确认Web服务是否正常运行，并检查端口是否被占用。

## 许可证

MIT