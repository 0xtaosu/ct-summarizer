from flask import Flask, request, jsonify
import pandas as pd
from datetime import datetime
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
        
    async def send_message(self, text):
        """发送消息到Telegram"""
        try:
            await self.bot.send_message(
                chat_id=self.chat_id,
                text=text,
                parse_mode='HTML'
            )
        except Exception as e:
            logging.error(f"发送Telegram消息失败: {str(e)}")

    def send_summary(self, period, summary):
        """发送总结到Telegram"""
        message = (
            f"<b>Twitter {period} 总结</b>\n"
            f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"{'='*30}\n\n"
            f"{summary}"
        )
        # 使用asyncio运行异步发送
        asyncio.run(self.send_message(message))

class TwitterDataProcessor:
    def __init__(self):
        self.data_dir = "data"
        self.twitter_file = os.path.join(self.data_dir, "twitter_data.csv")
        os.makedirs(self.data_dir, exist_ok=True)
        self.init_csv_file()
    
    def init_csv_file(self):
        """初始化CSV文件和列"""
        columns = [
            'timestamp',      # 事件发生时间
            'user_name',      # 用户名
            'event_type',     # 事件类型
            'content'         # 内容
        ]
        
        if not os.path.exists(self.twitter_file):
            pd.DataFrame(columns=columns).to_csv(self.twitter_file, index=False)
    
    def process_webhook_data(self, data):
        """处理webhook数据"""
        try:
            event_type = data.get('push_type', '')
            user_data = data.get('user', {})
            
            # 获取事件时间和内容
            timestamp = datetime.fromtimestamp(
                data.get('tweet', {}).get('publish_time') or 
                user_data.get('updated_at', time.time())
            ).isoformat()
            
            content = (data.get('tweet', {}).get('text') or 
                      user_data.get('description') or 
                      data.get('content', ''))
            
            # 构建行数据
            row = {
                'timestamp': timestamp,
                'user_name': user_data.get('name', ''),
                'event_type': event_type,
                'content': content
            }
            
            # 保存到CSV
            pd.DataFrame([row]).to_csv(self.twitter_file, mode='a', header=False, index=False)
            logging.info(f"数据已保存 - 事件类型: {event_type}")
            return True
            
        except Exception as e:
            logging.error(f"处理数据时出错: {str(e)}")
            return False

class TwitterSummarizer:
    def __init__(self):
        api_key = os.getenv('DEEPSEEK_API_KEY')
        if not api_key:
            raise ValueError("DEEPSEEK_API_KEY not found in environment variables")
            
        self.client = OpenAI(
            api_key=api_key,
            base_url="https://api.deepseek.com"
        )
        self.last_summary_time = {
            '5min': datetime.now(),
            '1hour': datetime.now(),
            '6hour': datetime.now(),
            '24hour': datetime.now()
        }
        # 初始化Telegram bot
        try:
            self.telegram = TelegramBot()
        except Exception as e:
            logging.error(f"初始化Telegram Bot失败: {str(e)}")
            self.telegram = None
            
        self.start_scheduled_summaries()
    
    def get_period_data(self, period):
        """获取指定时间段的新数据"""
        now = datetime.now()
        last_time = self.last_summary_time[period]
        
        try:
            df = pd.read_csv('data/twitter_data.csv')
            df['timestamp'] = pd.to_datetime(df['timestamp'])
            new_data = df[df['timestamp'] > last_time]
            
            # 更新最后总结时间
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
                f"时间: {e['timestamp']}, 用户: {e['user_name']}, "
                f"事件: {e['event_type']}, 内容: {e['content']}"
                for e in events
            ])

            prompts = {
                '5min': "请简要总结最近5分钟的Twitter活动要点。",
                '1hour': "请总结过去1小时的主要Twitter活动和趋势。",
                '6hour': "请分析过去6小时的Twitter活动，包括热门话题和重要互动。",
                '24hour': "请总结过去24小时的Twitter活动，分析主要话题走向。"
            }

            response = self.client.chat.completions.create(
                model="deepseek-chat",
                messages=[
                    {"role": "system", "content": prompts[period]},
                    {"role": "user", "content": f"请总结以下Twitter活动：\n{events_text}"}
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
            summary = self.generate_summary(period)
            # 打印到控制台
            print(f"\n=== {period} 定时总结 ===")
            print(f"总结时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            print(summary)
            print("="*50)
            
            # 发送到Telegram
            if self.telegram:
                self.telegram.send_summary(period, summary)

        # 设置定时任务
        schedule.every(5).minutes.do(lambda: generate_and_send_summary('5min'))
        schedule.every(1).hours.do(lambda: generate_and_send_summary('1hour'))
        schedule.every(6).hours.do(lambda: generate_and_send_summary('6hour'))
        schedule.every(24).hours.do(lambda: generate_and_send_summary('24hour'))

        threading.Thread(target=run_schedule, daemon=True).start()
        logging.info("定时总结任务已启动")

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