import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonDetailsText, comparisonDetailsTextCharacters, comparisonVisibleMainText } from '../../src/application/comparison-report-text.js';

test('details explanation counts all nested and hidden prose, headings and Unicode code points', () => {
  const html = '<p data-agent-slot="headline">结论</p><section data-agent-zone="comparison">主文</section><section data-agent-zone="details"><h3>方法</h3><details><summary>范围</summary><p>🛞 中文 &amp; 条件</p><details hidden><summary>内层</summary><p style="display:none">不能漏计</p></details></details><p hidden>隐藏段落</p><template>模板数据</template><script>脚本数据</script><style>样式数据</style></section>';
  const text = comparisonDetailsText(html);
  assert.equal(text, '方法 范围 🛞 中文 & 条件 内层 不能漏计 隐藏段落');
  assert.equal(comparisonDetailsTextCharacters(html), [...text].length);
  assert.ok(text.length > comparisonDetailsTextCharacters(html));
  assert.equal(comparisonVisibleMainText(html), '结论 主文');
});

test('main closed folds use the explanation budget while summaries and open-fold text are not counted twice', () => {
  const html = '<p data-agent-slot="headline">判</p><section data-agent-zone="comparison"><p hidden>隐藏主文</p><p style="display:none">另藏主文</p><details><summary>外摘要</summary><p>外正文</p><details><summary>内摘要</summary>内正文</details></details><details open><summary>展开摘要</summary>展开正文<details><summary>展开内摘要</summary>展开内隐藏</details></details></section><section data-agent-zone="details">补充</section>';
  assert.equal(comparisonVisibleMainText(html), '判 隐藏主文 另藏主文 外摘要 展开摘要 展开正文 展开内摘要');
  assert.equal(comparisonDetailsText(html), '补充 外正文 内摘要 内正文 展开内隐藏');
  const withoutDetailsZone = html.replace('<section data-agent-zone="details">补充</section>', '');
  assert.equal(comparisonDetailsText(withoutDetailsZone), '外正文 内摘要 内正文 展开内隐藏');
});

test('quotes are excluded only with Host validation precondition, never by the model component marker alone', () => {
  const quote = '<figure data-component="evidence-quote"><figcaption>历史 · 完整原文</figcaption><pre><code>长来源正文</code></pre></figure>';
  const html = `<section data-agent-zone="details"><h3>必要说明</h3>${quote}<p>局限</p><figure><figcaption>普通图说明</figcaption>分析正文</figure></section><section data-agent-zone="comparison"><details><summary>展开检查</summary>${quote}<p>检查限制</p></details></section>`;
  assert.equal(comparisonDetailsText(html), '必要说明 历史 · 完整原文 长来源正文 局限 普通图说明 分析正文 历史 · 完整原文 长来源正文 检查限制');
  assert.equal(comparisonDetailsText(html, { excludeValidatedQuotes: true }), '必要说明 局限 普通图说明 分析正文 检查限制');
  assert.equal(comparisonDetailsTextCharacters(html, { excludeValidatedQuotes: true }), [...'必要说明 局限 普通图说明 分析正文 检查限制'].length);
  assert.equal(comparisonDetailsText('<section data-agent-zone="details"><figure data-component="evidence-quote"><pre>来源</pre></figure></section>'), '来源');
});

test('empty reports, source-markup entities and duplicate zone nesting cannot hide additional explanation', () => {
  assert.equal(comparisonDetailsTextCharacters(''), 0);
  const html = '<section data-agent-zone="details"><p>第一段 &lt;details&gt;字面文本&lt;/details&gt;</p><section data-agent-zone="details">第二段</section></section><section data-agent-zone="details">第三段</section>';
  assert.equal(comparisonDetailsText(html), '第一段 <details>字面文本</details> 第二段 第三段');
  const nestedSummary = '<section data-agent-zone="comparison"><details><summary>可见<details><summary>内摘要</summary>隐藏于摘要</details></summary>隐藏正文</details></section>';
  assert.equal(comparisonDetailsText(nestedSummary), '隐藏于摘要 隐藏正文');
});
