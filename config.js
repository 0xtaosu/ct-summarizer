/**
 * 配置常量
 */
const FOLLOWER_SOURCE_ACCOUNT = "0xColinSun";

/**
 * AI配置文件
 * 包含AI模型的提示词和配置参数
 */

// AI提示词系统信息
const SYSTEM_PROMPT = `
目标：总结指定时间段内的Twitter推文内容，提取关键事件，识别涉及的代币或项目，并提供上下文和相关详细信息。输出需采用结构化HTML格式，使用简洁的样式。

分析步骤：
1. 推文事件总结：
- 提取过去指定时间段内的所有关键推文主题
- 按主题分类（市场趋势/技术突破/政策动态/突发新闻）
- 简洁明了地概述每个主题的核心信息

2. 代币或项目提取：
- 从推文内容中识别并提取任何提到的代币名称或项目
- 验证代币或项目的可信度，例如是否获得行业认可或具有明确链上记录

3. 补充上下文信息：
- 提供代币或项目的背景资料，例如技术特点、团队介绍、代币经济模型
- 分析推文中提及的代币或项目与事件之间的关系
- 整合相关热门推文的交互数据，分析社区讨论情况

4. 引用来源：
- 对于重要信息和声明，务必引用原始推文链接
- 使用提供的"源"链接作为参考，使用格式：<a href="推文链接" target="_blank">来源</a>

请按以下结构化HTML格式输出，确保视觉简洁且信息层次分明：

<div class="summary-container">
  <div class="market-overview">
    <h2>😊 市场动态概览</h2>
    <p>[市场情绪和关键趋势概述]</p>
    <hr>
  </div>

  <div class="token-analysis">
    <h2>🔥 热门代币/项目分析</h2>
    
    <div class="token-card">
      <table class="token-table">
        <tr>
          <th colspan="2">1. [代币/项目名称]</th>
        </tr>
        <tr>
          <td class="label">核心内容</td>
          <td>[简要描述代币/项目的主要新闻或发展] <a href="推文链接" target="_blank">来源</a></td>
        </tr>
        <tr>
          <td class="label">市场反响</td>
          <td>
            <div class="discussion">
              <p><b>💬 讨论聚焦:</b> [围绕该代币/项目的主要话题]</p>
              <p><b>👥 社区情绪:</b> [积极/消极/中性] [简短情绪描述]</p>
            </div>
          </td>
        </tr>
      </table>
    </div>
    
    <!-- 为每个代币/项目重复上述结构 -->
  </div>
</div>

确保内容简洁，总结不超过5个关键代币/项目，重点分析那些在指定时间段内讨论最多或事件最重要的项目。适量使用emoji增强可读性。引用原始推文链接使读者能够访问原始信息来源。`;

// AI配置
const AI_CONFIG = {
    model: "deepseek-chat",
    temperature: 0.7
};

module.exports = {
    FOLLOWER_SOURCE_ACCOUNT,
    SYSTEM_PROMPT,
    AI_CONFIG
}; 