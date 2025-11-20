/**
 * xAI Grok 调用示例：读取最近12小时的推文，拼接后请求 Grok-4
 *
 * 用法：
 *   1) 在 .env 中设置 XAI_API_KEY
 *   2) npm install
 *   3) node demo_xai.js
 */

require('dotenv').config();
const OpenAI = require('openai');
const { DatabaseManager } = require('./data');
const { AI_CONFIG } = require('./config');
const { TimeUtil } = require('./index');

/**
 * 将推文格式化为文本，和正式服务保持一致的格式
 * @param {Array} tweets
 * @returns {string}
 */
function formatTweetsForAI(tweets) {
  return tweets.map(tweet => {
    const tweetUrl = `https://x.com/${tweet.screen_name}/status/${tweet.id}`;
    return `用户: ${tweet.username} (@${tweet.screen_name})\n` +
      `发布时间: ${tweet.created_at}\n` +
      `内容: ${tweet.text}\n` +
      `\n源: ${tweetUrl}` +
      '\n' + '='.repeat(30);
  }).join('\n');
}

async function main() {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    console.error('请在 .env 中设置 XAI_API_KEY');
    process.exit(1);
  }

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.x.ai/v1',
    timeout: 360000
  });

  // 计算最近1小时区间（使用现有的 TimeUtil 逻辑）
  const period = '1hour';
  const { start, end, beijingStart, beijingEnd } = TimeUtil.calculateTimeRange(period);

  // 读取推文
  const db = new DatabaseManager(true);
  const tweets = await db.getTweetsInTimeRange(start, end);
  console.log(`找到 ${tweets.length} 条推文用于生成总结 (时间范围: ${beijingStart} ~ ${beijingEnd})`);

  if (!tweets.length) {
    console.log('没有推文可供总结，退出。');
    db.close();
    return;
  }

  const tweetsText = formatTweetsForAI(tweets);
  const userPrompt = `请扮演「总结大师」，基于以下推文生成 10 条中文要点，格式要求：
1) 每条前置索引 "1."、"2." … "10."
2) 聚焦事件和结论，语言简练，突出数字/影响/动作
3) 如能匹配到来源，末尾追加类似 [01] 的编号引用（需附上原文链接），如果有多个来源，那就添加来源[2][3]…
4) 保持列表紧凑，不要客套话

时间范围: ${beijingStart} ~ ${beijingEnd} (北京时间，最近1小时)

以下是推文原文片段：
${tweetsText}`;

  console.log(userPrompt);
  try {
    const completion = await client.chat.completions.create({
      model: AI_CONFIG.model || 'grok-4',
      messages: [
        { role: 'system', content: 'You are Grok, a highly intelligent, helpful AI assistant.' },
        { role: 'user', content: userPrompt }
      ],
      temperature: AI_CONFIG.temperature ?? 0.7
    });

    const message = completion?.choices?.[0]?.message?.content;
    console.log('\n=== Grok Response ===\n');
    console.log(message || 'No content returned.');
  } catch (error) {
    console.error('调用 xAI 失败:', error.message);
    if (error.response) {
      console.error('响应详情:', error.response.data || error.response);
    }
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('Demo 执行出错:', err);
});
