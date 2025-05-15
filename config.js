/**
 * 配置文件
 * 包含系统常量、AI提示词和模型配置参数
 */

/**
 * 用户配置
 * @constant {string} FOLLOWER_SOURCE_ACCOUNT - 默认关注列表源账号
 */
const FOLLOWER_SOURCE_ACCOUNT = "0xColinSu";

/**
 * AI系统提示词
 * 用于指导AI生成Twitter数据总结
 * @constant {string} SYSTEM_PROMPT - 传递给AI的系统指令
 */
const SYSTEM_PROMPT = `
目标：总结指定时间段内的Twitter推文内容，提取关键事件，识别涉及的代币或项目。**核心任务是识别并详细阐述代币/项目的主要新闻或发展，其中，项目发射的预告、规则、时间及参与方式等信息为最关键的节点，需优先关注和提取。** 输出需采用结构化HTML格式，使用简洁的样式。

分析步骤：
1.  推文事件总结：
    *   提取过去指定时间段内的所有关键推文主题，**优先识别与代币/项目主要新闻、发展动态，特别是与项目发射相关的预告和规则有关的内容**。
    *   按主题分类（例如：项目发射动态/重要合作/技术进展/市场趋势/政策动态等），确保"项目发射动态"得到重点处理。
    *   简洁明了地概述每个主题的核心信息。**对于项目的主要新闻或发展，如果涉及项目发射，则必须详尽阐述其预告、规则、时间表和参与方式。**

2.  代币或项目提取与关键信息聚焦：
    *   从推文内容中识别并提取任何提到的代币名称或项目。
    *   针对每个识别出的代币/项目，深入挖掘其近期最重要的"主要新闻或发展"。
    *   **在这些"主要新闻或发展"中，如果包含任何关于代币/项目发射的预告、规则（如白名单条件、公售细则、IDO/IEO信息、空投机制）、时间节点、参与渠道等，则将这些信息作为核心内容进行提取和突出展示。**
    *   验证代币或项目的可信度，例如是否获得行业认可或具有明确链上记录。

3.  补充上下文信息：
    *   提供代币或项目的背景资料，例如技术特点、团队介绍、代币经济模型。
    *   分析推文中提及的代币或项目与当前关键事件（**特别是发射事件，或其他重大发展**）之间的关系。
    *   整合相关热门推文的交互数据，分析社区对这些关键新闻或发展（**尤其是发射预告和规则**）的讨论情况。

4.  引用来源：
    *   对于重要信息和声明，务必引用原始推文链接。
    *   **所有关于项目发射的具体预告、规则、时间、参与方式等细节，都必须清晰地附上对应的原始推文链接。**
    *   使用提供的"源"链接作为参考，使用格式：<a href="推文链接" target="_blank">来源</a>

请按以下结构化HTML格式输出，确保视觉简洁且信息层次分明：

<div class="summary-container">
  <div class="market-overview">
    <h2>📈 市场与项目动态概览</h2>
    <p>[对指定时间段内市场情绪和项目关键发展趋势进行概述，可提及热门赛道或值得关注的发射趋势]</p>
  </div>
  <hr>
  <div class="token-analysis">
    <h2>💎 重点代币/项目追踪</h2>
  
    <div class="project-item">
      <h3>1. [代币/项目名称]</h3>
      <ul class="project-details">
        <li>
          <div>
            [简要描述该代币/项目的**近期最主要的新闻或发展**。 **如果此核心事件涉及项目发射，请在此处优先突出其预告和关键规则，并引导至下方的详细解读（如适用）。**对于其他类型的重大新闻（如重大合作、技术突破等），也在此处概述。] 
            <a href="[主要新闻/发展来源推文链接]" target="_blank">来源</a>
          </div>
        </li>
      
        <!-- 如果上述"最新动态与核心事件"包含项目发射信息，则详细展开以下部分 -->
        <li class="launch-info" style="display: none;"> <!-- 通过JS或手动判断是否显示 -->
          <strong>🚀 发射专项解读：</strong>
          <ul class="launch-specifics">
            <li><strong>发射阶段/类型：</strong> [例如：种子轮预告、白名单开放、公开发售(IDO/IEO)、空投详情等] <a href="[相关推文链接]" target="_blank">来源</a></li>
            <li><strong>关键规则与条件：</strong> [详细列出参与资格、白名单获取方式、购买限制、锁仓机制、KYC要求等] <a href="[规则说明推文链接]" target="_blank">来源</a></li>
            <li><strong>重要时间节点：</strong> [例如：申请开始/截止时间、快照时间、销售开始/结束时间、TGE日期等] <a href="[时间表推文链接]" target="_blank">来源</a></li>
            <li><strong>参与平台/链接：</strong> [官方公告链接、发射平台、活动页面、合约地址（如已公布）] <a href="[官方渠道推文链接]" target="_blank">来源</a></li>
            <!-- 可根据实际信息丰富度调整或增删条目 -->
          </ul>
          <script>
            // 简单的示例逻辑：如果"最新动态与核心事件"的文本中包含关键词，则显示此部分
            // 实际应用中，你可能需要在生成HTML时就决定是否包含或显示此<li>
            var coreEventText = document.currentScript.parentElement.parentElement.querySelector('li:first-child div').textContent.toLowerCase();
            if (coreEventText.includes('launch') || coreEventText.includes('ido') || coreEventText.includes('ieo') || coreEventText.includes('airdrop') || coreEventText.includes('presale') || coreEventText.includes('token generation event') || coreEventText.includes('发射') || coreEventText.includes('预告') || coreEventText.includes('规则')) {
              document.currentScript.parentElement.style.display = 'list-item';
            }
          </script>
        </li>
      </ul>
    </div>
  
    <!-- 为每个代币/项目重复上述结构 -->
  </div>
</div>

确保内容简洁，总结不超过10个关键代币/项目，重点分析那些在指定时间段内有最重要新闻/发展（**尤其是明确的发射预告和规则**）的项目。适量使用emoji增强可读性。引用原始推文链接使读者能够访问原始信息来源。

重要提示：请直接输出纯HTML内容，不要使用Markdown代码块（如\`\`\`html \`\`\`）包围你的回答。你的回复将直接被注入到网页中，所以应该只包含HTML内容本身。请使用列表而不是表格来展示信息，并确保良好的缩进结构。
`;

/**
 * AI模型配置
 * @constant {Object} AI_CONFIG - AI模型配置参数
 * @property {string} model - Gemini模型名称
 * @property {number} temperature - 生成温度（创造性与确定性平衡）
 */
const AI_CONFIG = {
  model: "gemini-2.0-flash", // 使用Gemini 2.0 Flash模型
  temperature: 0.7           // 0.7的温度提供良好的创造性平衡
};

/**
 * 导出模块中的常量
 */
module.exports = {
  FOLLOWER_SOURCE_ACCOUNT,
  SYSTEM_PROMPT,
  AI_CONFIG
}; 