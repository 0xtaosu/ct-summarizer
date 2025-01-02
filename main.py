from flask import Flask, request, jsonify
import pandas as pd
from datetime import datetime, timedelta
import json
# from deepseal import DeepSealAPI
import threading
import queue
import logging
import os

app = Flask(__name__)

# 创建一个队列用于存储接收到的数据
data_queue = queue.Queue()

# 设置日志配置
logging.basicConfig(
    filename='webhook.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

class TwitterDataAnalyzer:
    def __init__(self, deepseal_key):
        # self.deepseal_api = DeepSealAPI(deepseal_key)
        self.data_file = "twitter_data.csv"
        # 初始化DataFrame
        self.df = pd.DataFrame(columns=['id', 'text', 'created_at', 'timestamp'])
        self.df.to_csv(self.data_file, index=False)

    def save_to_csv(self, data):
        """将数据保存为CSV文件"""
        try:
            new_data = pd.DataFrame([data])
            new_data['timestamp'] = pd.to_datetime(new_data['created_at'])
            new_data.to_csv(self.data_file, mode='a', header=False, index=False)
            print(f"数据已保存: {data['id']}")
        except Exception as e:
            print(f"保存数据失败: {str(e)}")

    def summarize_data(self, time_window):
        """使用DeepSeal总结指定时间窗口的数据"""
        try:
            df = pd.read_csv(self.data_file)
            df['timestamp'] = pd.to_datetime(df['timestamp'])
            
            # 计算时间窗口
            end_time = datetime.now()
            if time_window == '5min':
                start_time = end_time - timedelta(minutes=5)
            elif time_window == '1hour':
                start_time = end_time - timedelta(hours=1)
            elif time_window == '24hour':
                start_time = end_time - timedelta(days=1)
            
            # 筛选时间范围内的数据
            filtered_data = df[(df['timestamp'] >= start_time) & 
                             (df['timestamp'] <= end_time)]
            
            if filtered_data.empty:
                return f"在{time_window}时间窗口内没有数据"

            # 构建Prompt
            prompt = f"""
            请总结以下时间段 ({start_time} 到 {end_time}) 的Twitter信息流中的关键信息：
            1. 识别主要话题和趋势
            2. 提取重要事件和新闻
            3. 分析情感倾向
            4. 总结用户反馈和讨论

            原始数据：
            {filtered_data['text'].to_string()}
            """
            
            # 调用DeepSeal进行总结
            summary = self.deepseal_api.generate(prompt)
            return summary
        except Exception as e:
            return f"总结数据失败: {str(e)}"

# 初始化分析器
analyzer = TwitterDataAnalyzer(deepseal_key="your_deepseal_key")

def validate_twitter_data(data):
    """验证推特数据的格式"""
    try:
        required_fields = ['id', 'text', 'created_at']
        return all(field in data for field in required_fields)
    except Exception as e:
        logging.error(f"数据验证错误: {str(e)}")
        return False

class TwitterDataProcessor:
    def __init__(self):
        self.data_dir = "data"
        self.twitter_file = os.path.join(self.data_dir, "twitter.csv")
        os.makedirs(self.data_dir, exist_ok=True)
        self.init_csv_file()
    
    def init_csv_file(self):
        """初始化CSV文件和列"""
        columns = [
            'event_type',          # 事件类型
            'timestamp',           # 事件时间
            'user_id',            # 用户ID
            'user_name',          # 用户名
            'screen_name',        # 用户屏幕名
            'content',            # 内容
            'tweet_id',           # 推文ID
            'media_type',         # 媒体类型
            'is_retweet',         # 是否转推
            'is_quote',           # 是否引用
            'is_reply',           # 是否回复
            'followers_count',     # 粉丝数
            'friends_count',       # 关注数
            'related_user_id',    # 相关用户ID
            'related_user_name'   # 相关用户名
        ]
        
        if not os.path.exists(self.twitter_file):
            pd.DataFrame(columns=columns).to_csv(self.twitter_file, index=False)
    
    def extract_user_info(self, user_data):
        """提取用户信息"""
        return {
            'user_id': user_data.get('id_str'),
            'user_name': user_data.get('name'),
            'screen_name': user_data.get('screen_name'),
            'followers_count': user_data.get('followers_count'),
            'friends_count': user_data.get('friends_count')
        }
    
    def process_new_tweet(self, data):
        """处理新推文事件"""
        user_info = self.extract_user_info(data['user'])
        tweet_data = data['tweet']
        
        return {
            **user_info,
            'event_type': 'new_tweet',
            'timestamp': datetime.fromtimestamp(tweet_data['publish_time']).isoformat(),
            'content': tweet_data['text'],
            'tweet_id': tweet_data['tweet_id'],
            'media_type': tweet_data.get('media_type', ''),
            'is_retweet': tweet_data['is_retweet'],
            'is_quote': tweet_data['is_quote'],
            'is_reply': tweet_data['is_reply'],
            'related_user_id': tweet_data.get('related_user_id', ''),
            'related_user_name': ''
        }
    
    def process_new_description(self, data):
        """处理用户修改简介事件"""
        user_info = self.extract_user_info(data['user'])
        
        return {
            **user_info,
            'event_type': 'new_description',
            'timestamp': datetime.fromtimestamp(data['user']['updated_at']).isoformat(),
            'content': data['user']['description'],
            'tweet_id': '',
            'media_type': '',
            'is_retweet': False,
            'is_quote': False,
            'is_reply': False,
            'related_user_id': '',
            'related_user_name': ''
        }
    
    def process_new_follower(self, data):
        """处理新关注事件"""
        user_info = self.extract_user_info(data['user'])
        follow_user = data.get('follow_user', {})
        
        return {
            **user_info,
            'event_type': 'new_follower',
            'timestamp': datetime.fromtimestamp(data['user']['updated_at']).isoformat(),
            'content': data.get('content', ''),
            'tweet_id': '',
            'media_type': '',
            'is_retweet': False,
            'is_quote': False,
            'is_reply': False,
            'related_user_id': follow_user.get('id_str', ''),
            'related_user_name': follow_user.get('name', '')
        }
    
    def process_webhook_data(self, data):
        """处理webhook数据"""
        try:
            event_type = data.get('push_type', '')
            
            # 根据事件类型选择处理方法
            processors = {
                'new_tweet': self.process_new_tweet,
                'new_description': self.process_new_description,
                'new_follower': self.process_new_follower
            }
            
            if event_type not in processors:
                logging.warning(f"未知的事件类型: {event_type}")
                return False
            
            # 处理数据
            row = processors[event_type](data)
            
            # 保存到CSV
            pd.DataFrame([row]).to_csv(self.twitter_file, mode='a', header=False, index=False)
            
            logging.info(f"数据已保存 - 事件类型: {event_type}")
            return True
            
        except Exception as e:
            logging.error(f"处理数据时出错: {str(e)}")
            return False

# 创建处理器实例
data_processor = TwitterDataProcessor()

@app.route('/webhook/twitter', methods=['POST'])
def webhook_receiver():
    """接收webhook推送的数据并处理"""
    try:
        logging.info("=== 收到新的 Webhook 请求 ===")
        logging.info(f"请求方法: {request.method}")
        logging.info(f"请求头: {dict(request.headers)}")
        
        json_data = request.json
        logging.info(f"JSON 数据: {json_data}")
        
        if data_processor.process_webhook_data(json_data):
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
    while True:
        try:
            # 从队列中获取数据
            data = data_queue.get()
            # 保存数据
            analyzer.save_to_csv(data)
            # 进行实时总结
            print("\n=== 数据总结 ===")
            print("5分钟总结：")
            print(analyzer.summarize_data('5min'))
            print("\n1小时总结：")
            print(analyzer.summarize_data('1hour'))
            print("\n24小时总结：")
            print(analyzer.summarize_data('24hour'))
        except Exception as e:
            print(f"处理数据失败: {str(e)}")

def start_server():
    """启动Flask服务器"""
    app.run(host='0.0.0.0', port=5000)

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "endpoint": "/webhook/twitter is ready"
    })

if __name__ == "__main__":
    # 创建并启动数据处理线程
    process_thread = threading.Thread(target=process_data)
    process_thread.daemon = True
    process_thread.start()
    
    # 启动Flask服务器
    start_server()