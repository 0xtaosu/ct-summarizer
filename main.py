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
                parse_mode='MarkdownV2'  # 改用 MarkdownV2
            )
            logging.info("Telegram消息发送成功")
        except Exception as e:
            logging.error(f"发送Telegram消息失败: {str(e)}")

    def send_summary(self, period, summary):
        """
        发送总结到Telegram
        使用Markdown格式化
        """
        # 转换时间段显示和对应的emoji
        period_info = {
            '30min': ('30分钟', '⏱️'),
            '1hour': ('1小时', '🕐'),
            '6hour': ('6小时', '⏰')
        }.get(period, (period, '🔔'))
        
        period_display, emoji = period_info

        # 转义Markdown特殊字符
        def escape_markdown(text):
            special_chars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!']
            for char in special_chars:
                text = text.replace(char, f'\\{char}')
            return text

        # 使用Markdown格式构建消息
        message = (
            f"{emoji} *Twitter {escape_markdown(period_display)}快讯*\n\n"
            f"📅 分析时间: `{escape_markdown(datetime.now().strftime('%Y-%m-%d %H:%M:%S'))} UTC`\n"
            f"📊 分析范围: 最近{escape_markdown(period_display)}的数据\n"
            f"{'_'*32}\n\n"
            f"*数据分析*\n"
            f"{escape_markdown(summary)}\n\n"
            f"{'_'*32}\n"
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
            '1hour': datetime.now(),
            '6hour': datetime.now()
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
            period: 时间段标识 ('30min', '1hour', '6hour')
        Returns:
            DataFrame: 符合时间条件的数据
        """
        now = datetime.now()
        # 根据时间段确定查询范围
        time_delta = {
            '30min': timedelta(minutes=30),
            '1hour': timedelta(hours=1),
            '6hour': timedelta(hours=6)
        }
        
        query_start = now - time_delta[period]
        
        try:
            df = pd.read_csv('data/twitter_data.csv')
            df['timestamp'] = pd.to_datetime(df['timestamp'])
            # 获取时间范围内的数据
            new_data = df[df['timestamp'] > query_start]
            
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
你的目标是在给定的内容中分析并找到当前加密市场中最具价值、具有长期投资潜力的叙事和项目。通过多维度分析，剖析市场热点与叙事背后的逻辑，筛选出值得长期重仓的潜力项目及其支持的核心理念。

1. 发布者背景评估：
- 分析发布者的背景、影响力和可信度
- 评估其在加密市场中的专业性和声誉

2. 内容分析：
- 检查技术信息的可验证性
- 评估项目细节和技术实现
- 分析市场前瞻性和热门趋势

叙事背景分析：
- 提取核心叙事（如AI Agent新场景、数据隐私等）
- 评估叙事与技术发展匹配度
- 确定叙事的基础框架能力和适用性

长期潜力评估：
- 技术支持：评估技术基础和创新性
- 经济模型：分析代币经济学可持续性
- 市场接受度：评估社区共识度

发布者及社区分析：
- 检查社区活跃度和生态支持
- 关注机构背书和投资人支持

数据驱动评估：
- 分析社交媒体互动和链上数据
- 评估情绪稳定性
- 跟踪资金流向

风险与长期价值分析：
- 评估抗风险能力
- 确定长期发展潜力

3. 市场热度分析：
- 评估互动数据和市场反响
- 分析社交媒体指标

4. 投资潜力评估：
- 综合评分（1-10分）
- 考虑多维度因素

5. 输出格式：
- 展示前五名内容和原始链接
- 详细说明投资潜力评分
- 提供具体的排名理由

请用专业、简洁的语言输出分析结果，重点突出长期投资价值。
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
        schedule.every(6).hours.do(lambda: generate_and_send_summary('6hour'))

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