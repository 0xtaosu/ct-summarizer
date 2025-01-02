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
        # 创建事件循环
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        
    async def send_message(self, text):
        """发送消息到Telegram"""
        try:
            await self.bot.send_message(
                chat_id=self.chat_id,
                text=text,
                parse_mode='HTML'
            )
            logging.info("Telegram消息发送成功")
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
        try:
            # 在事件循环中运行异步发送
            future = asyncio.run_coroutine_threadsafe(
                self.send_message(message), 
                self.loop
            )
            future.result()  # 等待发送完成
        except Exception as e:
            logging.error(f"发送总结到Telegram失败: {str(e)}")

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
    def __init__(self):
        self.data_dir = "data"
        self.twitter_file = os.path.join(self.data_dir, "twitter_data.csv")
        os.makedirs(self.data_dir, exist_ok=True)
        self.init_csv_file()
        
    def init_csv_file(self):
        """初始化CSV文件和列"""
        self.columns = [
            'timestamp',         # 事件发生时间
            'user_name',        # 用户名
            'user_description', # 用户简介
            'event_type',       # 事件类型
            'content'           # 内容
        ]
        
        # 如果文件不存在或为空，创建新文件
        if not os.path.exists(self.twitter_file) or os.path.getsize(self.twitter_file) == 0:
            pd.DataFrame(columns=self.columns).to_csv(self.twitter_file, index=False)
        else:
            # 验证现有文件的列
            try:
                df = pd.read_csv(self.twitter_file)
                if list(df.columns) != self.columns:
                    # 备份旧文件
                    backup_file = f"{self.twitter_file}.bak"
                    os.rename(self.twitter_file, backup_file)
                    logging.info(f"列不匹配，已备份旧文件到: {backup_file}")
                    # 创建新文件
                    pd.DataFrame(columns=self.columns).to_csv(self.twitter_file, index=False)
            except Exception as e:
                logging.error(f"验证CSV文件时出错: {str(e)}")
                # 创建新文件
                pd.DataFrame(columns=self.columns).to_csv(self.twitter_file, index=False)
    
    def process_webhook_data(self, data):
        """处理webhook数据"""
        try:
            event_type = data.get('push_type', '')
            user_data = data.get('user', {})
            
            # 获取事件时间
            timestamp = datetime.fromtimestamp(
                data.get('tweet', {}).get('publish_time') or 
                user_data.get('updated_at', time.time())
            ).isoformat()
            
            # 获取用户简介
            user_description = user_data.get('description', '')
            
            # 获取内容
            content = (data.get('tweet', {}).get('text') or 
                      data.get('content', ''))
            
            # 构建行数据
            row = {
                'timestamp': timestamp,
                'user_name': user_data.get('name', ''),
                'user_description': user_description,
                'event_type': event_type,
                'content': content
            }
            
            # 确保所有列都存在
            for col in self.columns:
                if col not in row:
                    row[col] = ''
            
            # 按照指定列顺序排列数据
            row = {col: row[col] for col in self.columns}
            
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
            self.telegram.start()  # 启动事件循环
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
                f"发布者: {e['user_name']}\n"
                f"发布者简介: {e['user_description']}\n"
                f"事件类型: {e['event_type']}\n"
                f"发布时间: {e['timestamp']}\n"
                f"内容: {e['content']}\n"
                f"{'='*30}"
                for e in events
            ])

            system_prompt = """
你是一个合格的媒体投资经理，需要分析社交媒体内容并评估投资价值。请按以下步骤分析：

1. 发布者背景评估：
- 分析发布者的背景、影响力和可信度
- 评估其在加密市场中的专业性和声誉

2. 内容分析：
- 检查是否包含可验证的技术信息
- 评估项目细节和技术实现的可靠性
- 分析与当前市场趋势的相关性

3. 市场热度分析：
- 评估内容的市场反响
- 分析与当前加密市场趋势的关联度

4. 投资潜力评估：
- 为每条内容打分（1-10分）
- 综合考虑发布者背景、内容可靠性和市场热度

5. 输出格式：
- 筛选并展示最具投资价值的前5条内容
- 说明每条内容的具体投资理由
- 如果内容少于5条，则分析所有可用内容

请用简洁专业的语言输出分析结果。
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