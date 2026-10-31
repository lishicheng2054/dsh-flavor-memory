# 插件市场上架材料（flavor-memory）

## 基本信息

- 名称：dsh-flavor-memory
- 版本：0.4.0
- 一句话：给 DSH 角色聊天加一层“记得住、忘得掉、不跑味”的本地长期记忆。
- 关键词：DSH 插件、长期记忆、角色聊天、上下文压缩、SillyTavern 角色卡、OpenAI 兼容

## 简介（可直接用）

长期聊天最怕两件事：上下文被占满，压缩之后角色变味。flavor-memory 把记忆拆成四层——人格锚点、场景卡、当前事实、原文片段——每轮只注入与当前问题相关的那一小部分，超预算时逐条裁剪，策略和人格永不丢。

- 300 轮长对话，注入约占原文 19%，关键事实、原话、礼物方向仍能召回；
- 支持 SillyTavern V2 角色卡、世界书、多条示例对话、关键词触发；
- 自带浅色控制台：角色编辑、记忆浏览、原文搜索、备份恢复；
- 纯本地 JSON，零外部依赖，不接向量库、不接图数据库、不调用额外模型。

## 安装

```powershell
npm install dsh-flavor-memory
```

或使用打包文件：

```powershell
npm install .\dsh-flavor-memory-0.4.0.tgz
```

## 配置

```yaml
- id: flavor-memory
  config:
    characterId: ayu
    characterName: 阿鱼
    dataFile: ~/.dsh/flavor-memory/memory.json
    profilesFile: ~/.dsh/flavor-memory/characters.json
    maxCards: 6
    voiceSamples: 3
    maxPromptChars: 4000
    autoCompactEvery: 20
    baseStabilityDays: 30
    soul: "阿鱼：嘴硬心软，先损后哄，不主动说教。"
    voice:
      - 叫她老板
      - 短句
      - 被关心时先嘴硬
    relationship: 刚开始互相试探
```

## 亮点

1. 人格锚点独立注入，不参与摘要，避免“压缩后变成旁白”。
2. 场景卡保留逐字原话和来源 ID，可回查原文。
3. 事实有有效期和取代关系，改口不会丢历史。
4. 检索按 IDF 加权、近似去重、相关性排序，常见词不压过问题词。
5. 预算超限逐条裁剪，先丢旧闲聊，最后才丢事实。
6. 语气样例只学句长和口癖，并过滤敏感回复。

## 适用 / 不适用

适用：单人长期角色聊天、DSH Web profile、需要本地可控记忆的用户。

不适用：多用户 SaaS、需要语义向量召回的超大规模知识库、直接登录 QQ 的场景（需要额外适配层）。

## 已知限制

- 检索是本地词法 + 别名，不是 embedding 语义检索；
- 事实抽取是正则，覆盖有限；
- JSON 单写者，多进程并发只保证文件不坏；
- 模型评审显示“留白/自然度”有优势，“语气贴合”尚未稳定胜出；
- 真人盲测工具已提供，但尚未执行。

## 截图位（待补）

1. 控制台首页（角色列表 + 记忆概览）
2. 角色卡编辑（世界书 / 示例对话 / 触发规则）
3. 记忆浏览（事实状态 + 原文搜索 + 备份）
4. 盲评页（A/B 评分）

## 链接

- README：`README.md`
- 测试报告：`TEST_REPORT.md`
- 变更日志：`CHANGELOG.md`
- 图标：`assets/icon.svg`
