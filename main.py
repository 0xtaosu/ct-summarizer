from flask import Flask, request, jsonify
import pandas as pd
from datetime import datetime, timedelta
import json
import threading
import queue
import logging
import os
import time
from openai import OpenAI
import schedule
from dotenv import load_dotenv
from telegram import Bot
import asyncio

# 加载环境变量
load_dotenv()

app = Flask(__name__)

# 创建数据队列
data_queue = queue.Queue()

# 设置日志配置
logging.basicConfig(
    filename='webhook.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

class TelegramBot:
    def __init__(self):
        self.token = os.getenv('TELEGRAM_BOT_TOKEN')
        self.chat_id = os.getenv('TELEGRAM_CHAT_ID')
        if not self.token or not self.chat_id:
            raise ValueError("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not found in environment variables")
        self.bot = Bot(token=self.token)
        # 创建事件循环
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        
    async def send_message(self, text):
        """发送消息到Telegram"""
        try:
            await self.bot.send_message(
                chat_id=self.chat_id,
                text=text,
                parse_mode='HTML'  # 使用HTML格式
            )
            logging.info("Telegram消息发送成功")
        except Exception as e:
            logging.error(f"发送Telegram消息失败: {str(e)}")

    def send_summary(self, period, summary):
        """
        发送总结到Telegram
        使用HTML格式化
        """
        # 转换时间段显示和对应的emoji
        period_info = {
            '30min': ('30分钟', '⏱️'),
            '1hour': ('1小时', '🕐')
        }.get(period, (period, '🔔'))
        
        period_display, emoji = period_info

        # 将Markdown格式转换为HTML格式
        def format_html(text):
            # 替换标题
            text = text.replace('# ', '<b>')
            text = text.replace('\n\n', '</b>\n\n')
            # 替换粗体
            text = text.replace('**', '<b>')
            # 替换斜体
            text = text.replace('*', '<i>')
            return text

        # 构建消息
        message = (
            f"{emoji} <b>Twitter {period_display}快讯</b>\n\n"
            f"📅 分析时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} UTC\n"
            f"📊 分析范围: 最近{period_display}的数据\n"
            f"{'—'*32}\n\n"
            f"<b>数据分析</b>\n"
            f"{format_html(summary)}\n\n"
            f"{'—'*32}\n"
            f"🤖 由 DeepSeek AI 提供分析支持"
        )
        
        try:
            future = asyncio.run_coroutine_threadsafe(
                self.send_message(message), 
                self.loop
            )
            future.result()
            logging.info(f"成功发送{period_display}总结到Telegram")
        except Exception as e:
            logging.error(f"发送{period_display}总结到Telegram失败: {str(e)}")

    def start(self):
        """启动事件循环"""
        def run_loop():
            self.loop.run_forever()
        
        # 在新线程中运行事件循环
        threading.Thread(target=run_loop, daemon=True).start()

    def stop(self):
        """停止事件循环"""
        self.loop.call_soon_threadsafe(self.loop.stop)

class TwitterDataProcessor:
    """
    Twitter数据处理器
    负责数据的存储、验证和格式化
    """
    def __init__(self):
        # 初始化数据目录和文件路径
        self.data_dir = "data"
        self.twitter_file = os.path.join(self.data_dir, "twitter_data.csv")
        os.makedirs(self.data_dir, exist_ok=True)
        
        # 定义CSV文件列
        self.columns = [
            'timestamp',         # 事件发生时间
            'user_name',        # 用户名
            'user_description', # 用户简介
            'event_type',       # 事件类型
            'content'           # 内容
        ]
        
        # 初始化CSV文件
        self.init_csv_file()
        
    def init_csv_file(self):
        """初始化或验证CSV文件结构"""
        # 文件不存在或为空时创建新文件
        if not os.path.exists(self.twitter_file) or os.path.getsize(self.twitter_file) == 0:
            pd.DataFrame(columns=self.columns).to_csv(self.twitter_file, index=False)
            return
            
        # 验证现有文件的列结构
        try:
            df = pd.read_csv(self.twitter_file)
            if list(df.columns) != self.columns:
                # 列不匹配时，备份旧文件并创建新文件
                backup_file = f"{self.twitter_file}.bak"
                os.rename(self.twitter_file, backup_file)
                logging.info(f"列不匹配，已备份旧文件到: {backup_file}")
                pd.DataFrame(columns=self.columns).to_csv(self.twitter_file, index=False)
        except Exception as e:
            logging.error(f"验证CSV文件时出错: {str(e)}")
            pd.DataFrame(columns=self.columns).to_csv(self.twitter_file, index=False)
    
    def process_webhook_data(self, data):
        """
        处理webhook推送的数据
        Args:
            data: webhook推送的JSON数据
        Returns:
            bool: 处理是否成功
        """
        try:
            # 提取基本信息
            event_type = data.get('push_type', '')
            user_data = data.get('user', {})
            
            # 构建时间戳
            timestamp = datetime.fromtimestamp(
                data.get('tweet', {}).get('publish_time') or 
                user_data.get('updated_at', time.time())
            ).isoformat()
            
            # 构建数据行
            row = {
                'timestamp': timestamp,
                'user_name': user_data.get('name', ''),
                'user_description': user_data.get('description', ''),
                'event_type': event_type,
                'content': (data.get('tweet', {}).get('text') or 
                           data.get('content', ''))
            }
            
            # 确保所有必需列都存在
            for col in self.columns:
                if col not in row:
                    row[col] = ''
            
            # 按照指定列顺序排列数据
            row = {col: row[col] for col in self.columns}
            
            # 保存到CSV文件
            pd.DataFrame([row]).to_csv(self.twitter_file, mode='a', header=False, index=False)
            logging.info(f"数据已保存 - 事件类型: {event_type}")
            return True
            
        except Exception as e:
            logging.error(f"处理数据时出错: {str(e)}")
            return False

class TwitterSummarizer:
    """
    Twitter内容总结器
    负责生成定期总结并通过Telegram发送
    """
    def __init__(self):
        # 初始化API客户端
        api_key = os.getenv('DEEPSEEK_API_KEY')
        if not api_key:
            raise ValueError("DEEPSEEK_API_KEY not found in environment variables")
            
        self.client = OpenAI(
            api_key=api_key,
            base_url="https://api.deepseek.com"
        )
        
        # 初始化时间记录
        self.last_summary_time = {
            '30min': datetime.now(),
            '1hour': datetime.now()
        }
        
        # 初始化Telegram机器人
        try:
            self.telegram = TelegramBot()
            self.telegram.start()
        except Exception as e:
            logging.error(f"初始化Telegram Bot失败: {str(e)}")
            self.telegram = None
            
        # 启动定时任务
        self.start_scheduled_summaries()
    
    def get_period_data(self, period):
        """
        获取指定时间段的新数据
        Args:
            period: 时间段标识 ('30min', '1hour')
        Returns:
            DataFrame: 符合时间条件的数据
        """
        now = datetime.now()
        # 更新时间段定义，移除6hou
        time_delta = {
            '30min': timedelta(minutes=30),
            '1hour': timedelta(hours=1)
        }
        
        query_start = now - time_delta[period]
        
        try:
            df = pd.read_csv('data/twitter_data.csv')
            df['timestamp'] = pd.to_datetime(df['timestamp'])
            new_data = df[df['timestamp'] > query_start]
            
            self.last_summary_time[period] = now
            return new_data
            
        except Exception as e:
            logging.error(f"获取{period}数据时出错: {str(e)}")
            return pd.DataFrame()

    def generate_summary(self, period):
        """使用 DeepSeek 生成总结"""
        try:
            df = self.get_period_data(period)
            if len(df) == 0:
                return f"在过去{period}内没有新的推文活动"

            events = df.to_dict('records')
            events_text = "\n".join([
                f"发布者: {e['user_name']}\n"
                f"发布者简介: {e['user_description']}\n"
                f"事件类型: {e['event_type']}\n"
                f"发布时间: {e['timestamp']}\n"
                f"内容: {e['content']}\n"
                f"{'='*30}"
                for e in events
            ])

            system_prompt = """
目标：总结指定时间段内的新闻内容，提取关键事件，识别涉及的代币地址或项目，并提供上下文及相关详细信息。

分析步骤：
1. 新闻事件总结：
- 提取所有关键新闻事件
- 按主题分类（市场趋势/技术突破/政策动态/突发新闻）
- 概述每个事件的核心信息

2. 代币地址或项目提取：
- 识别并提取代币地址或项目名称
- 验证地址或项目的可靠性

3. 补充上下文信息：
- 提供项目背景资料
- 分析项目与事件关系
- 整合相关新闻信息

请按以下格式输出：

一、新闻事件总结：

1. [新闻事件1标题]
   - 核心内容：…
   - 涉及项目：无/项目名称

2. [新闻事件2标题]
   - 核心内容：…
   - 涉及项目：无/项目名称

二、代币地址或项目分析：

- 项目名称：…
- 代币地址：…
- 背景信息：…
- 相关新闻内容：
  1. [相关新闻1]：…
  2. [相关新闻2]：…
"""

            user_prompt = f"请分析过去{period}的以下Twitter活动：\n{events_text}"

            response = self.client.chat.completions.create(
                model="deepseek-chat",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.7,
                stream=False
            )

            return response.choices[0].message.content

        except Exception as e:
            error_msg = f"生成{period}总结时出错: {str(e)}"
            logging.error(error_msg)
            return error_msg

    def start_scheduled_summaries(self):
        """启动定时总结任务"""
        def run_schedule():
            while True:
                schedule.run_pending()
                time.sleep(1)

        def generate_and_send_summary(period):
            """生成并发送总结"""
            summary = self.generate_summary(period)
            # 打印到控制台
            print(f"\n=== {period} 定时总结 ===")
            print(f"总结时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} UTC")
            print(summary)
            print("="*50)
            
            # 发送到Telegram
            if self.telegram:
                self.telegram.send_summary(period, summary)

        # 设置定时任务 (UTC时间)
        schedule.every(30).minutes.do(lambda: generate_and_send_summary('30min'))
        schedule.every(1).hour.do(lambda: generate_and_send_summary('1hour'))

        # 在新线程中运行定时任务
        threading.Thread(target=run_schedule, daemon=True).start()
        logging.info("定时总结任务已启动 (UTC)")

# 创建处理器实例
data_processor = TwitterDataProcessor()

@app.route('/webhook/twitter', methods=['POST'])
def webhook_receiver():
    """接收webhook推送的数据并处理"""
    try:
        logging.info("=== 收到新的 Webhook 请求 ===")
        logging.info(f"请求方法: {request.method}")
        logging.info(f"请求头: {dict(request.headers)}")
        logging.info(f"JSON 数据: {request.json}")
        
        if data_processor.process_webhook_data(request.json):
            return jsonify({
                "status": "success",
                "message": "Data processed and saved",
                "timestamp": datetime.now().isoformat()
            }), 200
        else:
            return jsonify({
                "status": "error",
                "message": "Failed to process data"
            }), 500
            
    except Exception as e:
        logging.error(f"处理请求时发生错误: {str(e)}")
        return jsonify({
            "status": "error",
            "message": str(e)
        }), 500

def process_data():
    """处理队列中的数据"""
    try:
        summarizer = TwitterSummarizer()
        
        while True:
            try:
                # 从队列中获取数据
                data = data_queue.get()
                # 保存数据
                data_processor.process_webhook_data(data)
                
            except Exception as e:
                logging.error(f"处理数据失败: {str(e)}")
    except Exception as e:
        logging.error(f"初始化 TwitterSummarizer 失败: {str(e)}")

if __name__ == "__main__":
    # 创建并启动数据处理线程
    process_thread = threading.Thread(target=process_data)
    process_thread.daemon = True
    process_thread.start()
    
    # 启动Flask服务器
    app.run(host='0.0.0.0', port=5000)