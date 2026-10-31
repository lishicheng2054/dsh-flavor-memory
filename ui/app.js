const API = '/flavor-memory/api';
const state = { characters: [], current: null, tab: 'basics', dirty: false, saving: false, filter: '', revisions: [], history: [], pending: [], memory: null, memoryHits: [], scopes: [] };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const uid = prefix => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const attr = value => esc(value).replace(/\n/g, '&#10;');
function blank() {
  return {
    version: 3, id: uid('character'), name: '新角色', description: '', personality: '', scenario: '', firstMessage: '',
    alternateGreetings: [], systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '', characterVersion: '', tags: [],
    soul: '', voice: [], relationship: '', examples: [], worldbook: [], triggers: [], loreUsage: {},
    pendingEvolutions: [], evolutionHistory: [], revisions: [],
    evolution: { soulMode: 'suggest', voiceMode: 'bounded', relationshipMode: 'bounded', maxSoulDelta: 0.05, maxVoiceDrift: 0.2, requireEvidence: true, requireApproval: true, keepOriginal: true, historyLimit: 50 },
  };
}
async function api(route, options = {}) {
  const response = await fetch(API + route, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || ('请求失败 (' + response.status + ')'));
  return payload;
}
function toast(message, error = false) {
  const node = $('#toast'); node.textContent = message;
  node.dataset.kind = error ? 'error' : 'success'; node.style.background = ''; node.style.color = '';
  node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2800);
}
function initials(name) { return String(name || '?').trim().slice(0, 2).toUpperCase(); }
function normalize(profile) {
  const next = { ...blank(), ...(profile || {}) };
  next.voice = Array.isArray(next.voice) ? next.voice : String(next.voice || '').split('\n').filter(Boolean);
  next.alternateGreetings = Array.isArray(next.alternateGreetings) ? next.alternateGreetings : String(next.alternateGreetings || '').split('\n').filter(Boolean);
  next.tags = Array.isArray(next.tags) ? next.tags : String(next.tags || '').split(/[,，]/).map(value => value.trim()).filter(Boolean);
  next.examples = Array.isArray(next.examples) ? next.examples : [];
  next.worldbook = Array.isArray(next.worldbook) ? next.worldbook : [];
  next.triggers = Array.isArray(next.triggers) ? next.triggers : [];
  next.loreUsage = next.loreUsage && typeof next.loreUsage === 'object' ? next.loreUsage : {};
  next.pendingEvolutions = Array.isArray(next.pendingEvolutions) ? next.pendingEvolutions : [];
  next.evolutionHistory = Array.isArray(next.evolutionHistory) ? next.evolutionHistory : [];
  next.revisions = Array.isArray(next.revisions) ? next.revisions : [];
  next.evolution = { ...blank().evolution, ...(next.evolution || {}) };
  return next;
}
function syncDirtyUi() {
  const pill = $('#dirtyPill'); if (pill) pill.hidden = !state.dirty;
  const button = $('#saveButton'); if (button) button.classList.toggle('dirty', state.dirty);
}
function markDirty(message) { state.dirty = true; syncDirtyUi(); $('#serverState').textContent = message || '有未保存的修改'; }
function setClean(message) { state.dirty = false; syncDirtyUi(); $('#serverState').textContent = message || ('已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })); }
function matchesFilter(profile) {
  const query = state.filter.trim().toLowerCase();
  if (!query) return true;
  return [profile.name, profile.id, ...(profile.tags || [])].join(' ').toLowerCase().includes(query);
}
function renderList() {
  const list = $('#characterList');
  const counter = $('#characterCount');
  if (counter) counter.textContent = String(state.characters.length);
  if (!state.characters.length) { list.innerHTML = '<p class="empty-mini">还没有角色。点下面新建，或导入酒馆角色卡。</p>'; return; }
  const shown = state.characters.filter(matchesFilter);
  if (!shown.length) { list.innerHTML = '<p class="empty-mini">没有匹配的角色。</p>'; return; }
  list.innerHTML = shown.map(profile => '<button type="button" class="character-item ' + (state.current && state.current.id === profile.id ? 'active' : '') + '" data-character="' + esc(profile.id) + '" aria-current="' + (state.current && state.current.id === profile.id ? 'true' : 'false') + '"><span class="avatar">' + esc(initials(profile.name)) + '</span><span class="character-meta"><b>' + esc(profile.name) + '</b><small>' + esc(profile.id) + (profile.tags && profile.tags.length ? ' · ' + esc(profile.tags.slice(0, 2).join('/')) : '') + '</small></span></button>').join('');
  $$('.character-item').forEach(node => node.addEventListener('click', () => selectCharacter(node.dataset.character)));
}
function renderBasics() {
  const profile = state.current || blank();
  for (const [id, value] of [
    ['#characterId', profile.id], ['#characterName', profile.name], ['#soul', profile.soul],
    ['#description', profile.description], ['#personality', profile.personality], ['#relationship', profile.relationship],
    ['#scenario', profile.scenario], ['#firstMessage', profile.firstMessage], ['#systemPrompt', profile.systemPrompt],
    ['#postHistoryInstructions', profile.postHistoryInstructions], ['#creatorNotes', profile.creatorNotes],
    ['#creator', profile.creator], ['#characterVersion', profile.characterVersion],
  ]) $(id).value = value || '';
  $('#voice').value = (profile.voice || []).join('\n');
  $('#alternateGreetings').value = (profile.alternateGreetings || []).join('\n');
  $('#tags').value = (profile.tags || []).join('，');
  $('#characterTitle').textContent = profile.name || '初始化角色';
  const subtitle = $('#characterSubtitle');
  if (subtitle) {
    const parts = [profile.id || '未保存的 ID'];
    if (profile.tags && profile.tags.length) parts.push(profile.tags.slice(0, 3).join(' / '));
    parts.push((profile.worldbook || []).length + ' 条世界书', (profile.examples || []).length + ' 条示例');
    subtitle.textContent = parts.join(' · ');
  }
}
function renderLore() {
  const list = $('#loreList'); const items = state.current?.worldbook || [];
  $('#worldCount').textContent = String(items.length);
  if (!items.length) { list.innerHTML = '<p class="empty-mini">还没有世界书条目。适合放地点、人物、规则和隐藏设定。</p>'; return; }
  list.innerHTML = items.map((item, index) => '<article class="lore-card" data-index="' + index + '"><div class="card-head"><b>' + esc(item.name || '条目 ' + (index + 1)) + '</b><div class="card-head-actions"><small class="usage">命中 ' + Number(state.current.loreUsage[item.id]?.count || 0) + ' 次</small><button type="button" class="icon-btn danger" data-remove-lore="' + index + '">删除</button></div></div><div class="grid two"><label class="field"><span>条目名称</span><input data-lore-field="name" value="' + attr(item.name) + '"></label><label class="field"><span>关键词 <em>逗号分隔</em></span><input data-lore-field="keywords" value="' + attr((item.keywords || []).join('，')) + '"></label></div><div class="grid three"><label class="field"><span>正则</span><input data-lore-field="regex" value="' + attr(item.regex) + '" placeholder="下雨|雨夜"></label><label class="field"><span>优先级 0-100</span><input data-lore-field="priority" type="number" min="0" max="100" value="' + esc(item.priority ?? 50) + '"></label><label class="field"><span>位置</span><select data-lore-field="position"><option value="before" ' + (item.position === 'before' ? 'selected' : '') + '>前置</option><option value="after" ' + (item.position === 'after' ? 'selected' : '') + '>后置</option><option value="replace" ' + (item.position === 'replace' ? 'selected' : '') + '>替换（按前置）</option></select></label></div><label class="field"><span>设定内容</span><textarea data-lore-field="content" rows="3">' + esc(item.content) + '</textarea></label><div class="grid three"><label class="field"><span>概率 %</span><input data-lore-field="probability" type="number" min="0" max="100" value="' + esc(item.probability ?? 100) + '"></label><label class="field"><span>冷却 ms</span><input data-lore-field="cooldownMs" type="number" min="0" value="' + esc(item.cooldownMs ?? 0) + '"></label><label class="field"><span>最多注入次数 <em>0 无限</em></span><input data-lore-field="maxInjections" type="number" min="0" value="' + esc(item.maxInjections ?? 0) + '"></label></div><div class="toggle-row"><label><input type="checkbox" data-lore-field="enabled" ' + (item.enabled !== false ? 'checked' : '') + '> 启用</label><label><input type="checkbox" data-lore-field="constant" ' + (item.constant ? 'checked' : '') + '> 常驻</label></div></article>').join('');
  $$('[data-remove-lore]').forEach(node => node.addEventListener('click', () => { state.current.worldbook.splice(Number(node.dataset.removeLore), 1); markDirty(); renderLore(); }));
  $$('[data-lore-field]').forEach(node => node.addEventListener('input', () => {
    const card = node.closest('.lore-card'); const item = state.current.worldbook[Number(card.dataset.index)]; const key = node.dataset.loreField;
    if (key === 'keywords') item.keywords = node.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
    else if (['priority', 'probability', 'cooldownMs', 'maxInjections'].includes(key)) item[key] = Number(node.value);
    else if (node.type === 'checkbox') item[key] = node.checked;
    else item[key] = node.value;
    markDirty();
  }));
}
function renderTriggers() {
  const list = $('#triggerList'); const items = state.current?.triggers || [];
  $('#triggerCount').textContent = String(items.length);
  if (!items.length) { list.innerHTML = '<p class="empty-mini">还没有触发规则。关键词命中后可关联世界书或注入一段短提示。</p>'; return; }
  const loreOptions = (state.current.worldbook || []).map(item => '<option value="' + esc(item.id) + '">' + esc(item.name || item.id) + '</option>').join('');
  list.innerHTML = items.map((item, index) => '<article class="example-card" data-trigger-index="' + index + '"><div class="card-head"><b>' + esc(item.name || '触发 ' + (index + 1)) + '</b><div class="card-head-actions"><button type="button" class="icon-btn danger" data-remove-trigger="' + index + '">删除</button></div></div><div class="grid two"><label class="field"><span>名称</span><input data-trigger-field="name" value="' + attr(item.name) + '"></label><label class="field"><span>关键词 <em>逗号分隔</em></span><input data-trigger-field="keywords" value="' + attr((item.keywords || []).join('，')) + '"></label></div><div class="grid two"><label class="field"><span>正则</span><input data-trigger-field="regex" value="' + attr(item.regex) + '"></label><label class="field"><span>优先级</span><input data-trigger-field="priority" type="number" min="0" max="100" value="' + esc(item.priority ?? 50) + '"></label></div><label class="field"><span>关联世界书 <em>按住 Ctrl 可多选；可选</em></span><select multiple data-trigger-field="loreIds">' + loreOptions + '</select></label><label class="field"><span>额外提示 <em>可留空</em></span><textarea data-trigger-field="prompt" rows="3">' + esc(item.prompt) + '</textarea></label><div class="toggle-row"><label><input type="checkbox" data-trigger-field="enabled" ' + (item.enabled !== false ? 'checked' : '') + '> 启用</label></div></article>').join('');
  $$('[data-trigger-index]').forEach(card => { const item = items[Number(card.dataset.triggerIndex)]; const select = card.querySelector('[data-trigger-field="loreIds"]'); for (const option of select.options) option.selected = item.loreIds?.includes(option.value); });
  $$('[data-remove-trigger]').forEach(node => node.addEventListener('click', () => { state.current.triggers.splice(Number(node.dataset.removeTrigger), 1); markDirty(); renderTriggers(); }));
  $$('[data-trigger-field]').forEach(node => node.addEventListener('input', () => {
    const card = node.closest('[data-trigger-index]'); const item = state.current.triggers[Number(card.dataset.triggerIndex)]; const key = node.dataset.triggerField;
    if (key === 'keywords') item.keywords = node.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
    else if (key === 'loreIds') item.loreIds = [...node.selectedOptions].map(option => option.value);
    else if (key === 'priority') item.priority = Number(node.value);
    else if (node.type === 'checkbox') item[key] = node.checked;
    else item[key] = node.value;
    markDirty();
  }));
}
function renderExamples() {
  const list = $('#exampleList'); const items = state.current?.examples || [];
  $('#exampleCount').textContent = String(items.length);
  if (!items.length) { list.innerHTML = '<p class="empty-mini">还没有示例对话。建议只放最能代表角色语气的 3–8 段。</p>'; return; }
  list.innerHTML = items.map((item, index) => '<article class="example-card" data-example-index="' + index + '"><div class="card-head"><b>示例 ' + (index + 1) + '</b><button type="button" class="icon-btn danger" data-remove-example="' + index + '">删除</button></div><div class="grid two"><label class="field"><span>用户</span><textarea data-example-field="user" rows="3">' + esc(item.user) + '</textarea></label><label class="field"><span>角色回复</span><textarea data-example-field="assistant" rows="3">' + esc(item.assistant) + '</textarea></label></div><label class="field"><span>标签 <em>逗号分隔</em></span><input data-example-field="tags" value="' + attr((item.tags || []).join('，')) + '" placeholder="雨天，关心，嘴硬"></label></article>').join('');
  $$('[data-remove-example]').forEach(node => node.addEventListener('click', () => { state.current.examples.splice(Number(node.dataset.removeExample), 1); markDirty(); renderExamples(); }));
  $$('[data-example-field]').forEach(node => node.addEventListener('input', () => {
    const card = node.closest('.example-card'); const item = state.current.examples[Number(card.dataset.exampleIndex)]; const key = node.dataset.exampleField;
    item[key] = key === 'tags' ? node.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean) : node.value; markDirty();
  }));
}
function renderEvolution() {
  const evolution = state.current?.evolution || blank().evolution;
  for (const key of ['soulMode', 'voiceMode', 'relationshipMode']) $('#' + key).value = evolution[key];
  $('#maxSoulDelta').value = String(evolution.maxSoulDelta); $('#maxVoiceDrift').value = String(evolution.maxVoiceDrift);
  $('#maxSoulOutput').textContent = Number(evolution.maxSoulDelta).toFixed(2); $('#maxVoiceOutput').textContent = Number(evolution.maxVoiceDrift).toFixed(2);
  $('#historyLimit').value = String(evolution.historyLimit);
  for (const key of ['requireEvidence', 'requireApproval', 'keepOriginal']) $('#' + key).checked = Boolean(evolution[key]);
  state.pending = state.current?.pendingEvolutions || []; state.history = state.current?.evolutionHistory || []; state.revisions = state.current?.revisions || [];
  $('#pendingCount').textContent = String(state.pending.length);
  $('#pendingList').innerHTML = state.pending.length ? state.pending.map(item => '<div class="change-card"><div><b>' + labelTarget(item.target) + '</b><small>' + esc(item.reason || '未填写原因') + '</small></div><div class="diff">' + renderDiff(item.before, item.after) + '</div><div class="evidence">证据：' + esc((item.evidence || []).join('，') || '无') + '</div><div class="change-actions"><button type="button" class="btn small primary" data-apply-evolution="' + esc(item.id) + '">接受</button><button type="button" class="btn small danger" data-reject-evolution="' + esc(item.id) + '">拒绝</button></div></div>').join('') : '<p class="empty-mini">没有待审批变化。</p>';
  $('#revisionList').innerHTML = state.revisions.length ? state.revisions.slice().reverse().map(item => '<div class="change-card compact"><div><b>' + esc(revisionLabel(item.kind)) + '</b><small>' + esc(formatTime(item.at)) + '</small></div><div class="change-actions"><button type="button" class="btn small" data-restore-revision="' + esc(item.id) + '">恢复此版本</button></div></div>').join('') : '<p class="empty-mini">还没有历史版本。首次审批变化时会自动保留原始版本。</p>';
  $('#historyList').innerHTML = state.history.length ? state.history.slice().reverse().slice(0, 20).map(item => '<div class="change-card compact"><div><b>' + labelTarget(item.target) + ' · ' + esc(item.status || 'applied') + '</b><small>' + esc(item.reason || '') + '</small></div><div class="diff mini">' + renderDiff(item.before, item.after) + '</div></div>').join('') : '<p class="empty-mini">还没有处理过变化。</p>';
  $$('[data-apply-evolution]').forEach(node => node.addEventListener('click', () => applyEvolution(node.dataset.applyEvolution)));
  $$('[data-reject-evolution]').forEach(node => node.addEventListener('click', () => rejectEvolution(node.dataset.rejectEvolution)));
  $$('[data-restore-revision]').forEach(node => node.addEventListener('click', () => restoreRevision(node.dataset.restoreRevision)));
}
function labelTarget(target) { return target === 'soul' ? '灵魂' : target === 'voice' ? '声音' : '关系'; }
function revisionLabel(kind) { return kind === 'original' ? '原始版本' : kind === 'evolution' ? '演化前版本' : '手动版本'; }
function formatTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString('zh-CN'); }
function renderDiff(before, after) { return '<del>' + esc(Array.isArray(before) ? before.join(' / ') : before) + '</del><ins>' + esc(Array.isArray(after) ? after.join(' / ') : after) + '</ins>'; }
function renderAll() {
  syncDirtyUi();
  renderList(); const has = Boolean(state.current); $('#emptyState').hidden = has; $('#editor').hidden = !has;
  if (!has) { $('#characterTitle').textContent = '初始化角色'; const subtitle = $('#characterSubtitle'); if (subtitle) subtitle.textContent = '还没有选择角色'; state.memory = null; return; }
  if (state.memory && state.memory.characterId !== state.current.id) state.memory = null;
  renderBasics(); renderLore(); renderTriggers(); renderExamples(); renderEvolution(); renderMemory();
}
function linesOf(selector) {
  return $(selector).value.split('\n').map(value => value.trim()).filter(Boolean);
}
function collectBasics() {
  return {
    ...state.current,
    id: $('#characterId').value.trim(), name: $('#characterName').value.trim() || '未命名角色',
    soul: $('#soul').value.trim(), description: $('#description').value.trim(), personality: $('#personality').value.trim(),
    relationship: $('#relationship').value.trim(), scenario: $('#scenario').value.trim(), firstMessage: $('#firstMessage').value.trim(),
    voice: linesOf('#voice'), alternateGreetings: linesOf('#alternateGreetings'),
    systemPrompt: $('#systemPrompt').value.trim(), postHistoryInstructions: $('#postHistoryInstructions').value.trim(),
    creatorNotes: $('#creatorNotes').value.trim(), creator: $('#creator').value.trim(),
    characterVersion: $('#characterVersion').value.trim(),
    tags: $('#tags').value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean),
  };
}
function collectEvolution() { return { ...state.current.evolution, soulMode: $('#soulMode').value, voiceMode: $('#voiceMode').value, relationshipMode: $('#relationshipMode').value, maxSoulDelta: Number($('#maxSoulDelta').value), maxVoiceDrift: Number($('#maxVoiceDrift').value), historyLimit: Number($('#historyLimit').value), requireEvidence: $('#requireEvidence').checked, requireApproval: $('#requireApproval').checked, keepOriginal: $('#keepOriginal').checked }; }
async function save() {
  if (!state.current || state.saving) return;
  if (!$('#characterId').value.trim()) return toast('请填写角色 ID', true);
  if (!$('#soul').value.trim()) return toast('角色至少要有灵魂锚点', true);
  state.saving = true; $('#saveButton').textContent = '保存中…';
  try {
    const saved = await api('/characters', { method: 'POST', body: JSON.stringify({ ...collectBasics(), evolution: collectEvolution() }) });
    const index = state.characters.findIndex(item => item.id === saved.id);
    state.characters = index >= 0 ? state.characters.map(item => item.id === saved.id ? saved : item) : [...state.characters, saved];
    state.current = normalize(saved); state.memory = null; state.dirty = false; renderAll(); setClean('已保存到本地'); toast('角色已保存，并同步记忆锚点');
  } catch (error) { toast(error.message, true); }
  finally { state.saving = false; $('#saveButton').textContent = '保存角色'; }
}
async function selectCharacter(id) {
  if (state.dirty && !confirm('当前有未保存的修改，切换角色会丢失。继续吗？')) return;
  try { state.current = normalize(await api('/characters/' + encodeURIComponent(id))); state.dirty = false; renderAll(); setClean('已连接本地配置'); }
  catch (error) { toast(error.message, true); }
}
function createCharacter() {
  if (state.dirty && !confirm('当前有未保存的修改，继续会丢失。确定新建吗？')) return;
  state.current = blank(); state.dirty = true; renderAll(); markDirty('新角色未保存'); switchTab('basics'); $('#characterName').focus();
}
function metric(label, value) {
  return '<div class="memory-metric"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
}
function renderMemory() {
  const view = state.memory;
  const memory = view && view.memory;
  const initial = view ? view.initialRelationship : (state.current && state.current.relationship);
  $('#initialRelationshipView').textContent = initial || '未设置';
  if (!view) {
    $('#memoryMetrics').innerHTML = '<p class="empty-mini">点击“刷新运行状态”读取当前记忆库。</p>';
    $('#currentRelationshipView').textContent = '等待读取';
    $('#memoryAnchor').textContent = '等待读取';
    $('#activeFacts').innerHTML = '<p class="empty-mini">还没有读取事实。</p>';
    $('#memoryCards').innerHTML = '<p class="empty-mini">还没有读取场景卡。</p>';
    return;
  }
  if (!memory) {
    $('#memoryMetrics').innerHTML = '<p class="empty-mini">记忆库里还没有这个角色。先保存角色或导入角色卡，记忆锚点会自动创建。</p>';
    $('#currentRelationshipView').textContent = '没有运行数据';
    $('#memoryAnchor').textContent = '没有运行数据';
    $('#activeFacts').innerHTML = '<p class="empty-mini">没有当前事实。</p>';
    $('#memoryCards').innerHTML = '<p class="empty-mini">没有场景卡。</p>';
    return;
  }
  const stats = memory.stats || {};
  const compression = memory.compression || {};
  $('#memoryMetrics').innerHTML = [
    metric('消息', String(stats.messages || 0)),
    metric('活跃场景卡', String(stats.activeCards || 0)),
    metric('原文档案', String(compression.rawChars || 0) + ' 字符'),
    metric('卡片占用', String(compression.cardChars || 0) + ' 字符'),
    metric('卡片相对原文', String(compression.savedPercent || 0) + '% 已移出'),
  ].join('');
  $('#currentRelationshipView').textContent = memory.currentRelationship || '还没有形成关系状态';
  $('#memoryAnchor').textContent = memory.anchor || '还没有人格回执';
  const active = memory.facts?.active || [];
  const history = memory.facts?.history || [];
  $('#activeFacts').innerHTML = active.length
    ? active.map(item => '<div class="memory-row"><b>' + esc(item.key) + '</b><span>' + esc(item.value) + '</span><small>' + esc((item.tags || []).join('，') || '当前事实') + (item.sourceId ? ' · 来源 ' + esc(item.sourceId) : '') + '</small></div>').join('') + (history.length ? '<p class="empty-mini">另有 ' + history.length + ' 条旧值保留在历史中。</p>' : '')
    : '<p class="empty-mini">没有当前事实。对话变化或在这里写入后会进入事实层。</p>';
  $('#memoryCards').innerHTML = (memory.cards || []).length
    ? memory.cards.map(card => '<article class="memory-card"><div class="card-head"><b>' + esc(card.id) + '</b><small>' + esc([card.time, card.place].filter(Boolean).join(' · ') || '未标时间地点') + '</small></div><div class="memory-line"><span>事件</span><p>' + esc((card.event || []).join('；') || '未记录') + '</p></div><div class="memory-line"><span>关系</span><p>' + esc(card.relation || '未变化') + '</p></div><div class="memory-line"><span>状态</span><p>' + esc((card.state || []).join('；') || '未记录') + '</p></div>' + ((card.quotes || []).length ? '<div class="memory-quote">“' + esc(card.quotes.map(item => item.text).join(' / ')) + '”</div>' : '') + '</article>').join('')
    : '<p class="empty-mini">还没有场景卡。每累计一批消息会自动生成；也可以由模型调用记忆工具手工写卡。</p>';
}
function renderScopes() {
  if (!$('#memoryScopeList') || !$('#scopeSummary')) return;
  const selected = $('#memoryScope').value.trim();
  $('#memoryScopeList').innerHTML = state.scopes.map(item =>
    '<option value="' + esc(item.scope) + '">' + esc((item.scope || '全局') + ' · ' + item.messages + ' 条') + '</option>'
  ).join('');
  $('#scopeSummary').innerHTML = state.scopes.length
    ? state.scopes.map(item => {
        const active = item.scope === selected;
        return '<button type="button" class="scope-chip' + (active ? ' active' : '') + '" data-scope="' + esc(item.scope) + '">' +
          '<b>' + esc(item.scope || '全局') + '</b><span>' + esc(item.messages) + ' 条</span></button>';
      }).join(' ')
    : '<span class="hint">还没有归档会话。先在 DSH 或网关里完成一轮对话。</span>';
  $$('#scopeSummary [data-scope]').forEach(node => node.addEventListener('click', () => {
    $('#memoryScope').value = node.dataset.scope || '';
    state.memory = null; state.memoryHits = []; renderMemoryHits(); renderScopes(); loadMemory();
  }));
}
async function loadScopes() {
  if (!state.current) return;
  const id = state.current.id;
  try {
    const result = await api('/memory/scopes?characterId=' + encodeURIComponent(id));
    if (state.current?.id !== id) return;
    state.scopes = result.scopes || [];
    renderScopes();
  } catch (error) {
    state.scopes = [];
    $('#memoryScopeList').innerHTML = '';
    $('#scopeSummary').innerHTML = '<span class="hint">会话列表读取失败。</span>';
    toast(error.message, true);
  }
}
async function loadMemory() {
  if (!state.current || !$('#memoryScope')) return;
  const id = state.current.id;
  $('#memoryStatus').textContent = '读取中…'; loadScopes();
  try {
    const scope = $('#memoryScope').value.trim();
    const view = await api('/memory?characterId=' + encodeURIComponent(id) + '&scope=' + encodeURIComponent(scope));
    if (state.current?.id === id) { state.memory = view; renderMemory(); $('#memoryStatus').textContent = '已读取'; }
  } catch (error) {
    state.memory = null; renderMemory(); $('#memoryStatus').textContent = '读取失败'; toast(error.message, true);
  }
}
function renderMemoryHits() {
  const hits = state.memoryHits || [];
  const status = $('#memorySearchStatus');
  if (!hits.length) {
    $('#memoryHits').innerHTML = '<p class="empty-mini">输入关键词后搜索。可以试“花生、约定、住址、雨夜”。</p>';
    return;
  }
  $('#memoryHits').innerHTML = hits.map(hit => '<button type="button" class="memory-hit' + (hit.pinned ? ' is-pinned' : '') + '" data-memory-id="' + esc(hit.id) + '"><span class="hit-top"><b>' + esc(hit.role === 'assistant' ? '角色原话' : hit.role === 'user' ? '用户原话' : '系统') + '</b><small>' + esc(formatTime(hit.at)) + '</small></span><span class="hit-text">' + esc(hit.snippet) + '</span><span class="hit-meta">' + esc((hit.why || []).join('，')) + ' · 相关度 ' + esc(Number(hit.score || 0).toFixed(2)) + (hit.pinned ? ' · 已保护' : hit.important ? ' · 重要' : '') + '</span></button>').join('');
  $$('[data-memory-id]').forEach(node => node.addEventListener('click', () => openMemoryHit(node.dataset.memoryId)));
  if (status) status.textContent = '找到 ' + hits.length + ' 条';
}
async function searchMemory() {
  if (!state.current) return;
  const query = $('#memoryQuery').value.trim();
  if (!query) return toast('先输入要搜的关键词', true);
  $('#memorySearchStatus').textContent = '搜索中…';
  try {
    const result = await api('/memory/search?characterId=' + encodeURIComponent(state.current.id) + '&scope=' + encodeURIComponent($('#memoryScope').value.trim()) + '&q=' + encodeURIComponent(query));
    state.memoryHits = result.hits || [];
    renderMemoryHits();
    if (!state.memoryHits.length) $('#memorySearchStatus').textContent = '没有命中，换一个更短的关键词试试';
  } catch (error) { state.memoryHits = []; renderMemoryHits(); $('#memorySearchStatus').textContent = ''; toast(error.message, true); }
}
async function openMemoryHit(id) {
  if (!state.current) return;
  try {
    const result = await api('/memory/read?characterId=' + encodeURIComponent(state.current.id) + '&scope=' + encodeURIComponent($('#memoryScope').value.trim()) + '&id=' + encodeURIComponent(id));
    const entry = result.entry || {};
    $('#memoryReadCard').hidden = false;
    $('#memoryReadTitle').textContent = entry.id || id;
    $('#memoryReadMeta').textContent = [entry.role === 'assistant' ? '角色' : entry.role === 'user' ? '用户' : entry.role, formatTime(entry.at), entry.tags?.length ? '标签：' + entry.tags.join('，') : ''].filter(Boolean).join(' · ');
    $('#memoryReadText').textContent = entry.text || '';
    $('#memoryReadCard').dataset.pinned = entry.pinned ? 'true' : 'false';
    const pinButton = $('#pinMemoryRead');
    pinButton.textContent = entry.pinned ? '取消保护' : '保护这条';
    pinButton.dataset.pinned = entry.pinned ? 'true' : 'false';
    $('#memoryReadCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) { toast(error.message, true); }
}

async function togglePinMemory() {
  if (!state.current || $('#memoryReadCard').hidden) return;
  const id = $('#memoryReadTitle').textContent;
  const pinned = $('#pinMemoryRead').dataset.pinned !== 'true';
  try {
    const result = await api('/memory/pin', { method: 'POST', body: JSON.stringify({ characterId: state.current.id, scope: $('#memoryScope').value.trim(), id, pinned }) });
    const entry = result.entry || {};
    $('#memoryReadCard').dataset.pinned = entry.pinned ? 'true' : 'false';
    $('#pinMemoryRead').dataset.pinned = entry.pinned ? 'true' : 'false';
    $('#pinMemoryRead').textContent = entry.pinned ? '取消保护' : '保护这条';
    state.memoryHits = (state.memoryHits || []).map(hit => hit.id === id ? { ...hit, pinned: Boolean(entry.pinned) } : hit);
    renderMemoryHits();
    if (entry.pinned) toast('已保护：这条记忆不再随时间衰减');
    else toast('已取消保护');
  } catch (error) { toast(error.message, true); }
}

async function saveFact() {
  if (!state.current) return;
  const key = $('#factKey').value.trim(); const value = $('#factValue').value.trim();
  if (!key || !value) return toast('事实键和值都要填写', true);
  $('#factStatus').textContent = '写入中…';
  try {
    const view = await api('/memory/fact', { method: 'POST', body: JSON.stringify({
      characterId: state.current.id, scope: $('#memoryScope').value.trim(), key, value,
      tags: $('#factTags').value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean),
    }) });
    state.memory = view; renderMemory(); $('#factKey').value = ''; $('#factValue').value = ''; $('#factTags').value = '';
    $('#factStatus').textContent = '已写入；旧值保留在历史'; toast('当前事实已更新');
  } catch (error) { $('#factStatus').textContent = ''; toast(error.message, true); }
}
function switchTab(name) {
  state.tab = name;
  $$('.tab').forEach(node => {
    const active = node.dataset.tab === name;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', active ? 'true' : 'false');
    node.tabIndex = active ? 0 : -1;
  });
  $$('.panel').forEach(node => node.classList.toggle('active', node.dataset.panel === name));
  if (window.scrollY > 0) window.scrollTo(0, 0);
  if (name === 'preview' && state.current) $('#previewQuery').focus();
  if (name === 'memory' && state.current) loadMemory();
}
async function deleteCharacter() {
  if (!state.current || state.saving) return;
  const name = state.current.name || state.current.id;
  if (!confirm('删除角色「' + name + '」？本地角色资料会被移除，记忆库里的运行记录保留。')) return;
  try {
    await api('/characters/' + encodeURIComponent(state.current.id), { method: 'DELETE' });
    state.characters = state.characters.filter(item => item.id !== state.current.id);
    state.current = null; state.memory = null; state.memoryHits = []; state.dirty = false;
    const next = state.characters[0];
    if (next) await selectCharacter(next.id); else { renderAll(); setClean('角色已删除'); }
    toast('已删除角色「' + name + '」');
  } catch (error) { toast(error.message, true); }
}
function duplicateCharacter() {
  if (!state.current) return;
  if (state.dirty && !confirm('当前有未保存的修改，继续会丢失。确定复制吗？')) return;
  const copy = normalize(JSON.parse(JSON.stringify(state.current)));
  copy.id = uid('character');
  copy.name = (state.current.name || '角色') + ' 副本';
  copy.pendingEvolutions = []; copy.evolutionHistory = []; copy.revisions = []; copy.loreUsage = {};
  state.current = copy; state.memoryHits = []; renderAll(); markDirty('复制出的新角色未保存'); switchTab('basics');
  toast('已复制为新角色，改好 ID 后保存');
}
async function preview() {
  if (!state.current) return;
  const query = $('#previewQuery').value.trim(); $('#previewStatus').textContent = '生成中…';
  try {
    const result = await api('/preview', { method: 'POST', body: JSON.stringify({ characterId: state.current.id, query, maxChars: 6000, examplesLimit: 3 }) });
    $('#previewPrompt').textContent = result.prompt || '（没有可注入的内容）'; $('#previewSize').textContent = '约 ' + result.chars + ' 字符';
    $('#previewHits').innerHTML = result.lore.length ? result.lore.map(item => '<div class="hit-card"><b>' + esc(item.name) + '</b><small>' + esc(item.reason) + ' · 优先级 ' + esc(item.priority) + ' · ' + esc(item.position) + '</small></div>').join('') : '<p class="empty-mini">这条消息没有命中世界书条目。</p>';
    $('#previewStatus').textContent = '预览已更新'; await refreshCharacterFromDisk(false);
  } catch (error) { $('#previewStatus').textContent = ''; toast(error.message, true); }
}
async function refreshCharacterFromDisk(render = true) {
  if (!state.current || state.dirty) return;
  const saved = normalize(await api('/characters/' + encodeURIComponent(state.current.id)));
  state.current = saved; state.characters = state.characters.map(item => item.id === saved.id ? saved : item); if (render) renderAll();
}
async function applyEvolution(id) {
  const candidate = state.pending.find(item => item.id === id); if (!candidate) return;
  if (!confirm('接受这次' + labelTarget(candidate.target) + '变化？')) return;
  try { const saved = normalize(await api('/evolution/apply', { method: 'POST', body: JSON.stringify({ characterId: state.current.id, candidate }) })); state.current = saved; updateCharacter(saved); renderAll(); toast('变化已应用，可在版本历史恢复'); }
  catch (error) { toast(error.message, true); }
}
async function rejectEvolution(id) {
  try { const saved = normalize(await api('/evolution/reject', { method: 'POST', body: JSON.stringify({ characterId: state.current.id, candidateId: id }) })); state.current = saved; updateCharacter(saved); renderAll(); toast('已拒绝并写入历史'); }
  catch (error) { toast(error.message, true); }
}
async function restoreRevision(id) {
  if (!confirm('恢复这个版本？当前角色内容会被替换，但历史记录仍会保留。')) return;
  try { const saved = normalize(await api('/revisions/restore', { method: 'POST', body: JSON.stringify({ characterId: state.current.id, revisionId: id }) })); state.current = saved; updateCharacter(saved); state.dirty = false; renderAll(); toast('已恢复历史版本'); }
  catch (error) { toast(error.message, true); }
}
function updateCharacter(saved) { state.characters = state.characters.map(item => item.id === saved.id ? saved : item); }
async function exportProfile() {
  if (!state.current) return;
  try {
    const exported = await api('/export?characterId=' + encodeURIComponent(state.current.id));
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = state.current.id + '.chara_card_v2.json'; link.click(); URL.revokeObjectURL(url);
    toast('已导出 SillyTavern V2 角色卡');
  } catch (error) { toast('导出失败：' + error.message, true); }
}
async function exportBackup() {
  try {
    const backup = await api('/backup/export');
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'flavor-memory-backup-' + new Date().toISOString().slice(0, 10) + '.json'; link.click(); URL.revokeObjectURL(url);
    toast('已导出全部角色与记忆档案');
  } catch (error) { toast('备份失败：' + error.message, true); }
}
async function importBackupFile(file) {
  if (!file) return;
  if (!confirm('导入备份会覆盖同 ID 角色的记忆档案，并写入备份里的角色资料。继续？')) return;
  try {
    const parsed = JSON.parse(await file.text());
    const result = await api('/backup/import', { method: 'POST', body: JSON.stringify(parsed) });
    const data = await api('/state');
    state.characters = (data.characters || []).map(normalize);
    state.current = null; state.memory = null; state.memoryHits = []; state.dirty = false;
    if (data.activeCharacterId || state.characters[0]) await selectCharacter(data.activeCharacterId || state.characters[0].id); else renderAll();
    toast('备份已导入：' + result.profiles + ' 个角色，' + result.memories + ' 份记忆');
  } catch (error) { toast('导入备份失败：' + error.message, true); }
}

async function importFile(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const imported = normalize(parsed?.data ? await api('/import', { method: 'POST', body: JSON.stringify(parsed) }) : parsed);
    imported.id = imported.id || uid('character');
    state.current = imported; state.dirty = !parsed?.data; renderAll(); switchTab('basics');
    if (parsed?.data) { state.dirty = false; const index = state.characters.findIndex(item => item.id === imported.id); state.characters = index >= 0 ? state.characters.map(item => item.id === imported.id ? imported : item) : [...state.characters, imported]; renderAll(); toast('酒馆角色卡已导入并保存'); }
    else toast('已导入普通 JSON，检查后点击保存');
  } catch (error) { toast('导入失败：' + error.message, true); }
}
async function proposeEvolution() {
  if (!state.current) return;
  const target = $('#proposeTarget').value;
  const rawValue = $('#proposeValue').value.trim();
  if (!rawValue) return toast('先填写变化后的内容', true);
  const evidence = $('#proposeEvidence').value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
  if (!evidence.length) return toast('至少填一个证据消息 ID；没有原文证据的变化会被拒绝', true);
  const value = target === 'voice' ? rawValue.split(/[,，\n]/).map(item => item.trim()).filter(Boolean) : rawValue;
  $('#proposeStatus').textContent = '提交中…';
  try {
    const result = await api('/evolution', { method: 'POST', body: JSON.stringify({
      characterId: state.current.id, target, value, evidence, reason: $('#proposeReason').value.trim(),
    }) });
    if (result.applied) {
      state.current = normalize(result.profile); updateCharacter(state.current); state.memory = null;
      $('#proposeStatus').textContent = '已按有权模式自动应用';
      toast('变化已应用，并同步记忆锚点');
    } else {
      state.current = normalize(await api('/characters/' + encodeURIComponent(state.current.id))); updateCharacter(state.current); state.memory = null;
      $('#proposeStatus').textContent = '已进入待审批';
      toast('变化已提交，等待审批');
    }
    state.dirty = false; $('#proposeValue').value = ''; $('#proposeEvidence').value = ''; $('#proposeReason').value = '';
    renderAll();
  } catch (error) { $('#proposeStatus').textContent = ''; toast(error.message, true); }
}
$('#duplicateCharacter').addEventListener('click', duplicateCharacter); $('#deleteCharacter').addEventListener('click', deleteCharacter);
$('#characterFilter').addEventListener('input', event => { state.filter = event.target.value; renderList(); });
$('#tabs').addEventListener('keydown', event => {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const tabs = $$('.tab');
  const index = tabs.findIndex(node => node.dataset.tab === state.tab);
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = tabs.length - 1;
  event.preventDefault(); tabs[next].focus(); switchTab(tabs[next].dataset.tab);
});
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') { event.preventDefault(); save(); }
});
$('#saveButton').addEventListener('click', save); $('#exportButton').addEventListener('click', exportProfile); $('#previewButton').addEventListener('click', preview);
$('#proposeEvolution').addEventListener('click', proposeEvolution); $('#refreshMemory').addEventListener('click', loadMemory); $('#saveFact').addEventListener('click', saveFact);
$('#searchMemory').addEventListener('click', searchMemory); $('#closeMemoryRead').addEventListener('click', () => { $('#memoryReadCard').hidden = true; });
$('#pinMemoryRead').addEventListener('click', togglePinMemory);
$('#memoryQuery').addEventListener('keydown', event => { if (event.key === 'Enter') searchMemory(); });
$('#memoryScope').addEventListener('keydown', event => { if (event.key === 'Enter') loadMemory(); });
$('#memoryScope').addEventListener('change', () => { state.memory = null; state.memoryHits = []; renderMemoryHits(); loadMemory(); });
$('#addLore').addEventListener('click', () => { state.current.worldbook.push({ id: uid('lore'), name: '条目 ' + (state.current.worldbook.length + 1), content: '', keywords: [], regex: '', priority: 50, position: 'before', enabled: true, constant: false, probability: 100, cooldownMs: 0, maxInjections: 0, tags: [] }); markDirty(); renderLore(); });
$('#addTrigger').addEventListener('click', () => { state.current.triggers.push({ id: uid('trigger'), name: '触发 ' + (state.current.triggers.length + 1), keywords: [], regex: '', loreIds: [], prompt: '', priority: 50, enabled: true }); markDirty(); renderTriggers(); });
$('#addExample').addEventListener('click', () => { state.current.examples.push({ id: uid('example'), user: '', assistant: '', tags: [] }); markDirty(); renderExamples(); });
$('#importButton').addEventListener('click', () => $('#fileInput').click()); $('#emptyImport').addEventListener('click', () => $('#fileInput').click());
$('#backupButton').addEventListener('click', exportBackup);
$('#backupImportButton').addEventListener('click', () => $('#backupInput').click());

$('#backupInput').addEventListener('change', async event => { await importBackupFile(event.target.files?.[0]); event.target.value = ''; });
$('#fileInput').addEventListener('change', async event => { await importFile(event.target.files?.[0]); event.target.value = ''; });
$$('.tab').forEach(node => node.addEventListener('click', () => switchTab(node.dataset.tab)));
for (const selector of ['#characterName', '#soul', '#description', '#personality', '#relationship', '#scenario', '#firstMessage', '#voice', '#characterId', '#systemPrompt', '#postHistoryInstructions', '#alternateGreetings', '#creatorNotes', '#creator', '#characterVersion', '#tags']) $(selector).addEventListener('input', () => { if (state.current && selector === '#characterName') $('#characterTitle').textContent = $('#characterName').value || '未命名角色'; markDirty(); });
for (const selector of ['#maxSoulDelta', '#maxVoiceDrift']) $(selector).addEventListener('input', () => { $('#' + (selector === '#maxSoulDelta' ? 'maxSoulOutput' : 'maxVoiceOutput')).textContent = Number($(selector).value).toFixed(2); markDirty(); });
for (const selector of ['#soulMode', '#voiceMode', '#relationshipMode', '#historyLimit', '#requireEvidence', '#requireApproval', '#keepOriginal']) $(selector).addEventListener('change', markDirty);
window.addEventListener('beforeunload', event => { if (!state.dirty) return; event.preventDefault(); event.returnValue = ''; });
async function load() {
  try { const data = await api('/state'); state.characters = (data.characters || []).map(normalize); $('#serverState').textContent = '已连接本地配置'; renderList(); if (data.activeCharacterId || state.characters[0]) await selectCharacter(data.activeCharacterId || state.characters[0].id); else renderAll(); }
  catch (error) { $('#serverState').textContent = '连接失败'; toast(error.message, true); }
}
load();

$('#newCharacter').addEventListener('click', createCharacter);
$('#emptyCreate').addEventListener('click', createCharacter);

