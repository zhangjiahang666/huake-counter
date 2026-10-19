// 跨页 jsdom 冒烟测试：加载 4 个页面 + app.js，验证无报错、导航高亮、核心数据流、缺元素安全
const fs = require('fs');
const path = require('path');
// jsdom 解析：优先本地 node_modules（CI 环境），回退到本机工作区（开发环境）
let jsdomMod = 'jsdom';
try { require.resolve('jsdom'); } catch (e) {
  jsdomMod = 'C:/Users/DELL/.workbuddy/binaries/node/workspace/node_modules/jsdom';
}
const { JSDOM, VirtualConsole } = require(jsdomMod);

const ROOT = path.join(__dirname, '..');
let JS = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
// 仅测试用：剥掉 IIFE 外壳 + 追加导出钩子，暴露内部函数供断言（不改源文件）
JS = JS.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
JS = JS.replace(/^\s*\(function\s*\(\)\s*\{/, '');
JS = JS.replace(/^\s*"use strict";\s*/, '');
JS = JS.replace(/\}\)\(\);\s*$/, '');
JS += '\n;window.__T = { doMerge: doMerge, sanitizeImport: sanitizeImport, undoLast: undoLast, render: render, renderCards: renderCards, renderHistory: renderHistory, renderOverview: renderOverview, renderRatio: renderRatio, renderRecent: renderRecent, renderFilter: renderFilter, monthlyAutoBackup: monthlyAutoBackup, parseCsv: parseCsv, renderReceipts: renderReceipts, readCardImage: readCardImage, normalizeState: normalizeState, save: save, saveLocal: saveLocal, cloudLoad: cloudLoad, cloudPush: cloudPush, cloudPull: cloudPull, cloudDownload: cloudDownload, cloudLogout: cloudLogout, cloud: function () { return CLOUD; } };\n';

const pages = ['index.html', 'cards.html', 'history.html', 'settings.html'];
let pass = 0, fail = 0;
const failMsgs = [];
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; failMsgs.push(msg); console.log('  ✗ ' + msg); } }
function loadPage(page) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://huake.test/' + page, pretendToBeVisual: true });
  const errors = [];
  dom.window.addEventListener('error', e => errors.push(e.message || String(e.error)));
  dom.window.fetch = undefined; // 测试环境断网：强制走本地模式，避免真实网络请求
  try { dom.window.eval(JS); } catch (e) { errors.push('eval: ' + e.message); }
  return { dom, window: dom.window, errors };
}

// ---- 1) 4 页加载 + 导航 active + 主题 ----
for (const page of pages) {
  console.log('\n=== ' + page + ' ===');
  const { window, errors } = loadPage(page);
  ok(errors.length === 0, '加载并执行无报错' + (errors.length ? ' ' + JSON.stringify(errors) : ''));
  const active = window.document.querySelector('.site-nav a.active');
  const expect = { 'index.html': '仪表盘', 'cards.html': '课时卡', 'history.html': '历史', 'settings.html': '设置' }[page];
  ok(active && active.textContent.trim() === expect, '导航 active = ' + expect);
  ok(window.eval('state.meta.theme') === 'light' || window.eval('state.meta.theme') === 'dark', 'applyTheme 已执行');
  const badge = window.document.getElementById('sync-badge');
  ok(badge && badge.textContent.indexOf('本地模式') >= 0, '无共享服务时显示「本地模式」角标');
}

// ---- 2) 行为级：cards.html 走真实 DOM 事件 ----
console.log('\n=== 行为级：cards.html（DOM 事件驱动）===');
{
  const { window } = loadPage('cards.html');
  const D = window.document;
  const get = id => D.getElementById(id);
  // 新增卡（先弹类型选择，再选「添加课时」）
  get('btn-add').click();
  ok(!D.getElementById('modal-add-type').classList.contains('hidden'), '点「+ 添加课时卡」先弹出类型选择');
  D.querySelector('#modal-add-type [data-add-kind="lesson"]').click();
  ok(D.getElementById('modal-add-type').classList.contains('hidden'), '选择类型后关闭选择弹窗');
  get('card-name').value = '数学';
  get('card-total').value = '10';
  get('card-lowwarn').value = '2';
  get('card-save').click();
  let st = JSON.parse(window.localStorage.getItem('huake_data_v1'));
  ok(st.cards.length === 1, '新增课时卡成功（localStorage）');
  ok(st.cards[0].kind === 'lesson' && st.cards[0].price === 0, '按「添加课时」创建的是课时卡');
  ok(st.cards[0].total - st.cards[0].used === 10, '初始剩余=10');

  // 划掉 1.5
  D.querySelector('[data-act="subtract"]').click();
  get('op-count').value = '1.5';
  get('op-date').value = '2026-10-18';
  get('op-confirm').click();
  st = JSON.parse(window.localStorage.getItem('huake_data_v1'));
  ok(st.cards[0].total - st.cards[0].used === 8.5, '划掉1.5后剩余=8.5');
  ok(st.history.length === 1, '历史记录+1');
  ok(typeof st.history[0].operatorName === 'string', '历史记录保留操作人兼容字段（不再写入人名）');

  // 加课 3
  D.querySelector('[data-act="add"]').click();
  get('op-count').value = '3';
  get('op-confirm').click();
  st = JSON.parse(window.localStorage.getItem('huake_data_v1'));
  ok(st.cards[0].total - st.cards[0].used === 11.5, '加课3后剩余=11.5');

  // 撤销（走内部函数，等价 history.html 的 #btn-undo-last）
  window.__T.undoLast();
  st = JSON.parse(window.localStorage.getItem('huake_data_v1'));
  ok(st.cards[0].total - st.cards[0].used === 8.5, '撤销后剩余回到8.5');
  ok(st.history.length === 1, '撤销后历史回到1条');

  // 导入合并
  const imp = JSON.stringify({ cards: [{ id: 'x2', name: '英语', total: 5, used: 0, lowWarn: 1, note: '', color: '#10b981' }], history: [] });
  const clean = window.__T.sanitizeImport(JSON.parse(imp));
  ok(clean.cards.length === 1, 'sanitizeImport 解析出1张卡');
  window.__T.doMerge(clean);
  st = JSON.parse(window.localStorage.getItem('huake_data_v1'));
  ok(st.cards.length === 2, '合并后共2张卡');

  // 课时卡加封面图：编辑第一张卡并写入图片
  D.querySelector('[data-act="edit"]').click();
  window.eval('cardImageData = "data:image/png;base64,AAA";');
  D.getElementById('card-save').click();
  st = JSON.parse(window.localStorage.getItem('huake_data_v1'));
  ok(st.cards[0].image === 'data:image/png;base64,AAA', '课时卡封面图已保存');
  ok(D.querySelectorAll('#cards .card-thumb img').length === 1, '卡片缩略图已渲染');

  // normalizeState 补齐缺失字段（共享同步的安全网）
  const norm = window.__T.normalizeState({ cards: [{ id: 'c1', name: '旧卡', total: 5, used: 0 }] });
  ok(Array.isArray(norm.operators) && norm.operators.length >= 1, 'normalizeState 补齐 operators');
  ok(norm.meta && typeof norm.meta.syncedAt === 'string', 'normalizeState 补齐 meta.syncedAt');
  ok(norm.cards[0].image === '' && Array.isArray(norm.cards[0].receipts), 'normalizeState 补齐 card.image/receipts');
  ok(Array.isArray(norm.attachments), 'normalizeState 补齐 attachments');

  // 每月自动备份：空数据时仅更新月份标记、不触发下载（下载依赖浏览器 URL.createObjectURL，jsdom 不支持）
  window.eval('state.cards = []; state.history = []; state.meta.lastAutoBackupMonth = "2000-01";');
  window.__T.monthlyAutoBackup();
  ok(window.eval('state.meta.lastAutoBackupMonth') !== '2000-01', 'monthlyAutoBackup 空数据分支更新月份标记且不报错');
}

// ---- 2b) 成员管理已移除：UI 不存在，旧数据字段仍兼容 ----
console.log('\n=== 成员管理已移除（settings.html）===');
{
  const { window, errors } = loadPage('settings.html');
  const D = window.document;
  ok(!D.getElementById('operators') && !D.getElementById('op-add') && !D.getElementById('op-new-name'),
    'settings 页面已无成员管理 UI');
  ok(errors.length === 0, 'settings 页面全程无报错' + (errors.length ? ' ' + JSON.stringify(errors) : ''));
  // 旧备份兼容：operators/currentOperator 字段照常解析，不影响使用
  const norm = window.__T.normalizeState({
    cards: [{ id: 'c1', name: '旧卡', total: 5, used: 0 }],
    operators: [{ id: 'a', name: '小红' }],
    meta: { currentOperator: 'a' }
  });
  ok(Array.isArray(norm.operators) && norm.operators.length === 1, 'normalizeState 仍兼容旧 operators 数据');
  ok(norm.meta.currentOperator === 'a', 'normalizeState 保留旧 currentOperator');
  window.__T.render();
  ok(errors.length === 0, '带旧成员数据调用 render() 也不报错');
}

// ---- 2c) 历史展示：旧记录显示名字，新记录不显示「操作人」 ----
console.log('\n=== 历史展示：操作人显示已按需隐藏 ===');
{
  const { window } = loadPage('history.html');
  const D = window.document;
  window.eval('state.cards=[{id:"c1",name:"瑜伽",total:10,used:0,lowWarn:3,note:"",color:"#4f7cff",createdAt:""}];' +
    'state.history=[{id:"h1",cardId:"c1",cardName:"瑜伽",date:new Date().toISOString(),delta:-1,lessonDate:"",note:"第一节课",operatorId:"a",operatorName:"小红"},' +
    '{id:"h2",cardId:"c1",cardName:"瑜伽",date:new Date().toISOString(),delta:-2,lessonDate:"",note:"",operatorId:"",operatorName:""}]; save();');
  window.__T.render();
  const subs = D.querySelectorAll('#history .hist-sub');
  ok(subs.length === 2, '未筛选时显示 2 条');
  ok(subs[0].textContent.indexOf('小红') < 0 && subs[1].textContent.indexOf('小红') >= 0,
    '仅旧记录显示成员名，新记录不显示「操作人」');
  ok(!D.getElementById('filter-operator'), '历史页已无操作人筛选框');
  // 月份筛选仍在
  const msel = D.getElementById('filter-month');
  const thisM = new Date().getFullYear() + '-' + ('0' + (new Date().getMonth() + 1)).slice(-2);
  msel.value = thisM;
  window.__T.renderHistory();
  ok(D.querySelectorAll('#history li').length === 2, '按当前月份筛选仍显示 2 条');
  msel.value = '';
  // 关键词搜索：卡名 / 备注
  const hs = D.getElementById('history-search');
  hs.value = '瑜伽'; window.__T.renderHistory();
  ok(D.querySelectorAll('#history li').length === 2, '搜索卡名命中 2 条');
  hs.value = '第一节课'; window.__T.renderHistory();
  ok(D.querySelectorAll('#history li').length === 1, '搜索备注只命中 1 条');
  hs.value = '不存在的词'; window.__T.renderHistory();
  ok(D.querySelectorAll('#history li').length === 0, '搜索无结果时不显示记录');
  ok(!D.getElementById('history-empty').classList.contains('hidden') &&
    D.getElementById('history-empty').textContent.indexOf('没有匹配') >= 0, '历史空状态提示「没有匹配的记录」');
  hs.value = ''; window.__T.renderHistory();
  ok(D.querySelectorAll('#history li').length === 2, '清空搜索恢复 2 条');
}

// ---- 2e) 课时卡收据：cards.html ----
console.log('\n=== 课时卡收据：cards.html ===');
{
  const { window } = loadPage('cards.html');
  const D = window.document;
  const get = id => D.getElementById(id);
  get('btn-add').click();
  get('card-name').value = '瑜伽';
  get('card-total').value = '20';
  get('card-save').click();
  ok(!!D.querySelector('[data-act="receipt"]'), '卡片按钮区存在「收据」按钮');
  D.querySelector('[data-act="receipt"]').click();
  ok(!D.getElementById('modal-receipt').classList.contains('hidden'), '收据弹窗已打开');
  ok(D.getElementById('receipt-card-name').textContent === '瑜伽', '收据弹窗显示卡名');
  window.eval('state.cards[0].receipts=[' +
    '{id:"r1",kind:"image",name:"receipt.png",data:"data:image/png;base64,AAA",size:100,addedBy:"op_default",addedName:"默认",date:new Date().toISOString()},' +
    '{id:"r2",kind:"sheet",name:"fee.csv",data:"项目,金额\\n瑜伽课,199\\n私教,599",size:50,addedBy:"op_default",addedName:"默认",date:new Date().toISOString()}' +
    ']; save();');
  window.__T.renderReceipts();
  ok(D.querySelectorAll('#receipt-list .receipt-item').length === 2, '收据列表渲染 2 项');
  ok(D.querySelectorAll('#receipt-list table.sheet tbody tr').length === 2, '收据 CSV 预览 2 行');
  // parseCsv 单测（收据表格预览共用该解析器）
  const rows = window.__T.parseCsv('a,b\n1,2');
  ok(rows.length === 2 && rows[0][0] === 'a' && rows[0][1] === 'b', 'parseCsv 正确解析表头');
  ok(D.querySelectorAll('#receipt-list .att-thumb img').length === 1, '收据图片缩略图已渲染');
  // 删除表格收据（cards.html 有确认弹窗，需点确认）
  D.querySelector('[data-del-receipt="r2"]').click();
  get('confirm-ok').click();
  let st = JSON.parse(window.localStorage.getItem('huake_data_v1'));
  ok(st.cards[0].receipts.length === 1 && st.cards[0].receipts[0].kind === 'image', '删除收据成功，图片收据保留');
  // 导入兼容：含收据的备份可被 sanitizeImport 解析
  const clean = window.__T.sanitizeImport(JSON.parse(JSON.stringify(st)));
  ok(clean.cards[0].receipts.length === 1, 'sanitizeImport 保留 card.receipts');
}

// ---- 2f) 文件夹分组：cards.html 走真实 DOM 事件 ----
console.log('\n=== 文件夹分组：cards.html（DOM 事件驱动）===');
{
  const { window } = loadPage('cards.html');
  const D = window.document;
  const get = id => D.getElementById(id);
  const readSt = () => JSON.parse(window.localStorage.getItem('huake_data_v1'));

  ok(D.querySelectorAll('#folder-bar .folder-chip').length === 2, '无文件夹时只显示「全部」和新建按钮');

  // 新建文件夹
  D.querySelector('[data-folder-new]').click();
  ok(!D.getElementById('modal-folder').classList.contains('hidden'), '点击后弹出新建文件夹弹窗');
  get('folder-name').value = '瑜伽';
  get('folder-save').click();
  let st = readSt();
  ok(st.folders.length === 1 && st.folders[0].name === '瑜伽', '文件夹已保存');
  ok(D.querySelectorAll('#folder-bar .folder-item').length === 1, '文件夹栏出现新文件夹');
  ok(D.querySelector('#folder-bar .folder-item .folder-chip').classList.contains('active'), '新建后自动选中该文件夹');

  // 重名拦截
  D.querySelector('[data-folder-new]').click();
  get('folder-name').value = '瑜伽';
  get('folder-save').click();
  ok(!D.getElementById('modal-folder').classList.contains('hidden'), '重名被拦截，弹窗不关闭');
  D.querySelector('#modal-folder [data-close]').click();

  // 建卡归入当前文件夹（先过类型选择）
  get('btn-add').click();
  D.querySelector('#modal-add-type [data-add-kind="lesson"]').click();
  get('card-name').value = '瑜伽A';
  get('card-total').value = '10';
  get('card-save').click();
  st = readSt();
  ok(st.cards.length === 1 && st.cards[0].folderId === st.folders[0].id, '新建卡片默认归入当前文件夹');
  ok(D.querySelector('#folder-bar .folder-item .folder-n').textContent === '1', '文件夹计数=1');

  // 未分组筛选：看不到文件夹中的卡
  D.querySelector('#folder-bar button[data-folder="__none__"]').click();
  ok(D.querySelectorAll('#cards .card').length === 0, '未分组筛选：看不到文件夹中的卡');
  ok(!D.getElementById('empty').classList.contains('hidden'), '空分类显示空状态');

  // 全部筛选：看到卡片且带文件夹标签
  D.querySelector('#folder-bar button[data-folder=""]').click();
  ok(D.querySelectorAll('#cards .card').length === 1, '全部筛选：看到卡片');
  ok(D.querySelector('#cards .card-folder').textContent.indexOf('瑜伽') >= 0, '卡片显示所属文件夹标签');

  // 第二个文件夹 + 编辑卡片换文件夹
  D.querySelector('[data-folder-new]').click();
  get('folder-name').value = '普拉提';
  get('folder-save').click();
  D.querySelector('#folder-bar button[data-folder=""]').click();
  D.querySelector('#cards [data-act="edit"]').click();
  st = readSt();
  get('card-folder').value = st.folders[1].id;
  get('card-save').click();
  st = readSt();
  ok(st.cards[0].folderId === st.folders[1].id, '编辑卡片可更换文件夹');
  var counts = D.querySelectorAll('#folder-bar .folder-item .folder-n');
  ok(counts[0].textContent === '0' && counts[1].textContent === '1', '两个文件夹计数各自正确');

  // 重命名
  D.querySelector('#folder-bar [data-folder-rename]').click();
  ok(D.getElementById('folder-modal-title').textContent === '重命名文件夹', '重命名弹窗标题正确');
  get('folder-name').value = '瑜伽·周末';
  get('folder-save').click();
  st = readSt();
  ok(st.folders[0].name === '瑜伽·周末', '文件夹已重命名');

  // 删除文件夹：卡片回未分组，数据不丢
  D.querySelectorAll('#folder-bar [data-folder-del]')[1].click();
  get('confirm-ok').click();
  st = readSt();
  ok(st.folders.length === 1, '删除后剩 1 个文件夹');
  ok(st.cards.length === 1 && st.cards[0].folderId === '', '卡片回到未分组且未丢失');

  // normalizeState 单测
  const norm = window.__T.normalizeState({ cards: [{ id: 'c1', name: '旧卡', total: 5, used: 0, folderId: 'ghost' }] });
  ok(Array.isArray(norm.folders) && norm.folders.length === 0, 'normalizeState 补齐 folders');
  ok(norm.cards[0].folderId === '', 'normalizeState 清掉指向不存在文件夹的 folderId');
  const norm2 = window.__T.normalizeState({ cards: [], folders: [{ id: 'f1', name: 'A' }] });
  ok(norm2.folders.length === 1 && typeof norm2.folders[0].createdAt === 'string', 'normalizeState 保留并补齐文件夹字段');

  // 导入兼容：sanitizeImport 解析文件夹及归属，doMerge 合并
  const clean = window.__T.sanitizeImport({
    cards: [{ id: 'x9', name: '导入卡', total: 5, used: 0, folderId: 'f9' }],
    folders: [{ id: 'f9', name: '导入夹' }],
    history: []
  });
  ok(clean.folders.length === 1 && clean.cards[0].folderId === 'f9', 'sanitizeImport 解析文件夹及归属');
  window.__T.doMerge(clean);
  st = readSt();
  ok(st.folders.length === 2 && st.cards.length === 2, '合并导入带入文件夹和卡片');
  ok(st.cards.some(c => c.folderId === 'f9'), '合并后卡片归属保留');

  // ---- 移动到文件夹 ----
  // 回到干净状态：一个文件夹「瑜伽」+ 一张未分组卡
  window.eval('state.folders = [{id:"fA",name:"瑜伽",createdAt:new Date().toISOString()}];' +
    'state.cards = [{id:"cA",name:"瑜伽A",total:10,used:1,lowWarn:2,note:"",color:"#4f7cff",createdAt:"",image:"",receipts:[],folderId:""}];' +
    'state.history = []; save();');
  window.__T.render();
  ok(D.querySelectorAll('#cards [data-act="move"]').length === 1, '卡片操作区有「📁 移动」按钮');
  D.querySelector('#cards [data-act="move"]').click();
  ok(!D.getElementById('modal-move').classList.contains('hidden'), '点击移动弹出选择弹窗');
  ok(D.getElementById('move-card-name').textContent.indexOf('当前：未分组') >= 0, '弹窗显示当前归属');
  ok(D.querySelectorAll('#move-list .move-item').length === 2, '弹窗列出「未分组」和 1 个文件夹');
  ok(D.querySelector('#move-list .move-item.active').getAttribute('data-move-to') === '', '「未分组」标记为当前');

  // 移到「瑜伽」
  D.querySelector('#move-list .move-item[data-move-to="fA"]').click();
  st = readSt();
  ok(st.cards[0].folderId === 'fA', '点文件夹后卡片归属已更新');
  ok(D.getElementById('modal-move').classList.contains('hidden'), '移动后弹窗关闭');
  ok(D.getElementById('toast').textContent.indexOf('已移动到') >= 0, '移动成功有提示');

  // 再移回未分组
  D.querySelector('#cards [data-act="move"]').click();
  D.querySelector('#move-list .move-item[data-move-to=""]').click();
  st = readSt();
  ok(st.cards[0].folderId === '', '可移回未分组');

  // 拖拽到文件夹栏（jsdom 无 DragEvent，用同类型普通事件驱动相同处理器）
  const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  const cardEl = D.querySelector('#cards .card');
  const chip = D.querySelector('#folder-bar button[data-folder="fA"]');
  fire(cardEl, 'dragstart');
  fire(chip, 'dragover');
  ok(chip.classList.contains('drop-hover'), '拖到文件夹上时高亮');
  fire(chip, 'drop');
  st = readSt();
  ok(st.cards[0].folderId === 'fA', '拖拽释放后卡片归入该文件夹');
  ok(!chip.classList.contains('drop-hover'), '释放后取消高亮');

  // 拖到「未分组」（移动后 DOM 已重绘，需重新取元素）
  fire(D.querySelector('#cards .card'), 'dragstart');
  fire(D.querySelector('#folder-bar button[data-folder="__none__"]'), 'drop');
  st = readSt();
  ok(st.cards[0].folderId === '', '拖到「未分组」可移出文件夹');

  // 回归：编辑弹窗的下拉仍能改归属
  D.querySelector('#folder-bar button[data-folder=""]').click();
  D.querySelector('#cards [data-act="edit"]').click();
  get('card-folder').value = 'fA';
  get('card-save').click();
  st = readSt();
  ok(st.cards[0].folderId === 'fA', '编辑弹窗下拉仍可更换文件夹');
}

// ---- 2g) 搜索 / 批量移动 / 课包 ----
console.log('\n=== 搜索 / 批量移动 / 课包（cards.html）===');
{
  const { window } = loadPage('cards.html');
  const D = window.document;
  const get = id => D.getElementById(id);
  const readSt = () => JSON.parse(window.localStorage.getItem('huake_data_v1'));
  const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  const cardsNow = () => D.querySelectorAll('#cards .card');

  // 造数据：2 个文件夹 + 3 张卡（含 1 个课包）
  window.eval('state.folders=[{id:"f1",name:"瑜伽",createdAt:new Date().toISOString()},{id:"f2",name:"游泳",createdAt:new Date().toISOString()}];' +
    'state.cards=[' +
    '{id:"c1",name:"瑜伽A",total:10,used:1,lowWarn:2,note:"周末班",color:"#4f7cff",createdAt:"",image:"",receipts:[],folderId:"f1",kind:"lesson",price:0,purchasedAt:""},' +
    '{id:"c2",name:"游泳B",total:20,used:2,lowWarn:3,note:"",color:"#4f7cff",createdAt:"",image:"",receipts:[],folderId:"f2",kind:"lesson",price:0,purchasedAt:""},' +
    '{id:"c3",name:"游泳年卡",total:30,used:5,lowWarn:3,note:"恒温池",color:"#4f7cff",createdAt:"",image:"",receipts:[],folderId:"",kind:"package",price:3000,purchasedAt:"2026-01-15"}];' +
    'state.history=[]; save();');
  window.__T.render();
  ok(cardsNow().length === 3, '渲染 3 张卡');

  // ---- 搜索 ----
  const si = get('card-search');
  si.value = '瑜伽'; fire(si, 'input');
  ok(cardsNow().length === 1, '搜索卡名「瑜伽」只剩 1 张');
  si.value = '恒温池'; fire(si, 'input');
  ok(cardsNow().length === 1 && cardsNow()[0].querySelector('.card-name').textContent.indexOf('游泳年卡') >= 0,
    '搜索备注关键词也能命中课包');
  si.value = '不存在的词'; fire(si, 'input');
  ok(cardsNow().length === 0, '无匹配时不显示卡片');
  ok(!get('empty').classList.contains('hidden') && get('empty').textContent.indexOf('没有匹配') >= 0,
    '空状态提示「没有匹配的课时卡」');
  si.value = ''; fire(si, 'input');
  ok(cardsNow().length === 3, '清空搜索恢复全部');

  // ---- 课包卡片展示 ----
  const pkgCard = D.querySelector('#cards .card.pkg');
  ok(!!pkgCard, '课包卡片带 .pkg 标记');
  ok(pkgCard.querySelector('.card-kind').textContent === '课包', '课包显示「课包」徽标');
  ok(pkgCard.textContent.indexOf('购价 ¥3000') >= 0, '课包显示购价');
  ok(pkgCard.textContent.indexOf('购买于 2026-01-15') >= 0, '课包显示购买日期');
  ok(pkgCard.textContent.indexOf('剩余价值 ¥2500') >= 0, '课包显示剩余价值（3000×25/30）');

  // ---- 批量管理 ----
  get('btn-manage').click();
  ok(!get('batch-bar').classList.contains('hidden'), '进入批量管理显示工具条');
  ok(get('btn-manage').textContent === '完成管理', '按钮文案变为「完成管理」');
  cardsNow()[0].click();
  ok(D.querySelectorAll('#cards .card.selected').length === 1, '点卡片可勾选');
  ok(get('batch-count').textContent === '已选 1 张', '工具条显示已选数量');
  cardsNow()[1].click();
  ok(D.querySelectorAll('#cards .card.selected').length === 2, '可勾选第二张');
  get('batch-all').click();
  ok(D.querySelectorAll('#cards .card.selected').length === 3, '全选选中全部可见卡片');
  get('batch-all').click();
  ok(D.querySelectorAll('#cards .card.selected').length === 0, '再点一次取消全选');
  get('batch-all').click();
  get('batch-move').click();
  ok(!get('modal-move').classList.contains('hidden'), '批量移动弹窗打开');
  ok(get('move-card-name').textContent.indexOf('3') >= 0, '弹窗提示已选 3 张');
  D.querySelector('#move-list .move-item[data-move-to="f2"]').click();
  let st = readSt();
  ok(st.cards.every(c => c.folderId === 'f2'), '3 张卡全部归入「游泳」');
  ok(D.querySelectorAll('#cards .card.selected').length === 0, '移动后清空选择');
  ok(get('toast').textContent.indexOf('已移动 2 张') >= 0, '批量移动提示实际移动数量');

  // ---- 添加课包（走类型选择） ----
  get('btn-add').click();
  D.querySelector('#modal-add-type [data-add-kind="package"]').click();
  ok(get('card-modal-title').textContent === '添加课包', '选课包后弹窗标题为「添加课包」');
  ok(!get('pkg-fields').classList.contains('hidden'), '课包字段显示');
  ok(get('card-total-label').textContent === '课包数', '课包模式下「总课时」标签改为「课包数」');
  get('card-name').value = '普拉提课包';
  get('card-total').value = '12';
  get('card-price').value = '2400';
  get('card-purchased').value = '2026-02-01';
  get('card-save').click();
  st = readSt();
  const pkg = st.cards.find(c => c.name === '普拉提课包');
  ok(!!pkg && pkg.kind === 'package' && pkg.price === 2400 && pkg.purchasedAt === '2026-02-01',
    '课包保存 kind/price/purchasedAt');

  // ---- 添加课时（默认类型） ----
  get('btn-add').click();
  D.querySelector('#modal-add-type [data-add-kind="lesson"]').click();
  ok(get('pkg-fields').classList.contains('hidden'), '选课时后课包字段隐藏');
  ok(get('card-total-label').textContent === '总课时', '课时模式下标签恢复为「总课时」');
  get('card-name').value = '瑜伽C';
  get('card-total').value = '8';
  get('card-save').click();
  st = readSt();
  const les = st.cards.find(c => c.name === '瑜伽C');
  ok(!!les && les.kind === 'lesson' && les.price === 0, '课时卡保存为 lesson 且无价格');

  // ---- 编辑：课时 ↔ 课包 互切 ----
  D.querySelector('#cards .card[data-id="' + les.id + '"] [data-act="edit"]').click();
  ok(get('card-modal-title').textContent === '编辑课时卡', '编辑课时卡标题正确');
  D.querySelector('#card-kind [data-kind="package"]').click();
  ok(!get('pkg-fields').classList.contains('hidden'), '编辑中可切到课包');
  get('card-price').value = '500';
  get('card-save').click();
  st = readSt();
  ok(st.cards.find(c => c.id === les.id).kind === 'package', '编辑后类型变为课包');

  // ---- 导入兼容 ----
  const clean = window.__T.sanitizeImport({
    cards: [{ id: 'p1', name: '导入课包', total: 5, used: 0, kind: 'package', price: 99, purchasedAt: '2026-03-03' }],
    folders: [], history: []
  });
  ok(clean.cards[0].kind === 'package' && clean.cards[0].price === 99 && clean.cards[0].purchasedAt === '2026-03-03',
    'sanitizeImport 解析课包字段');
  const clean2 = window.__T.sanitizeImport({ cards: [{ id: 'p2', name: '旧卡', total: 5, used: 0 }], history: [] });
  ok(clean2.cards[0].kind === 'lesson' && clean2.cards[0].price === 0, '旧备份无 kind 时默认识别为课时');
}

// ---- 2h) 批量排序 / 存储用量 / 多标签同步 / 图片压缩 / PWA 文件 ----
console.log('\n=== 批量排序 / 存储用量 / 多标签同步 / 图片压缩 / PWA ===');
{
  const { window } = loadPage('cards.html');
  const D = window.document;
  const get = id => D.getElementById(id);
  const readSt = () => JSON.parse(window.localStorage.getItem('huake_data_v1'));
  const order = () => Array.prototype.map.call(D.querySelectorAll('#cards .card'), el => el.getAttribute('data-id'));

  // 种子：3 张卡
  window.eval('state.cards=[' +
    '{id:"c1",name:"卡一",total:10,used:0,lowWarn:2,note:"",color:"#4f7cff",createdAt:"",image:"",receipts:[],folderId:"",kind:"lesson",price:0,purchasedAt:""},' +
    '{id:"c2",name:"卡二",total:10,used:0,lowWarn:2,note:"",color:"#4f7cff",createdAt:"",image:"",receipts:[],folderId:"",kind:"lesson",price:0,purchasedAt:""},' +
    '{id:"c3",name:"卡三",total:10,used:0,lowWarn:2,note:"",color:"#4f7cff",createdAt:"",image:"",receipts:[],folderId:"",kind:"lesson",price:0,purchasedAt:""}];' +
    'state.history=[]; save();');
  window.__T.render();
  ok(order().join(',') === 'c1,c2,c3', '初始顺序 c1,c2,c3');

  // 批量排序：勾选 c3 上移/下移
  get('btn-manage').click();
  D.querySelector('#cards .card[data-id="c3"]').click();
  get('batch-up').click();
  ok(order().join(',') === 'c1,c3,c2', '勾选 c3 点上移后排到第二位');
  get('batch-up').click();
  ok(order().join(',') === 'c3,c1,c2', '再点上移排到第一位');
  get('batch-down').click();
  ok(order().join(',') === 'c1,c3,c2', '点下移退回第二位');
  ok(readSt().cards.map(c => c.id).join(',') === 'c1,c3,c2', '排序结果已写入 localStorage');
  get('batch-cancel').click();
  ok(get('batch-bar').classList.contains('hidden'), '退出管理后工具条隐藏');

  // PWA：manifest 链接与文件在位
  ok(!!D.querySelector('link[rel="manifest"]'), '页面引入 manifest');
  ok(fs.existsSync(path.join(ROOT, 'manifest.webmanifest')) &&
     fs.existsSync(path.join(ROOT, 'sw.js')) &&
     fs.existsSync(path.join(ROOT, 'icon-192.png')) &&
     fs.existsSync(path.join(ROOT, 'icon-512.png')) &&
     fs.existsSync(path.join(ROOT, 'icon-maskable-512.png')), 'PWA 文件（manifest/sw/三尺寸图标）齐全');

  // 多标签同步：模拟其他标签写入并派发 storage 事件
  const other = JSON.parse(window.localStorage.getItem('huake_data_v1'));
  other.cards.push({ id: 'c9', name: '别处新增', total: 5, used: 0, lowWarn: 1, note: '', color: '#4f7cff', createdAt: '', image: '', receipts: [], folderId: '', kind: 'lesson', price: 0, purchasedAt: '' });
  other.meta.syncedAt = 'ts-from-other-tab';
  window.dispatchEvent(new window.StorageEvent('storage', { key: 'huake_data_v1', newValue: JSON.stringify(other) }));
  ok(window.eval('state.cards.length') === 4, '其他标签的新数据被本标签自动采用');
  ok(D.querySelectorAll('#cards .card').length === 4, '采用后页面自动重绘');
  window.eval('state.meta.pendingSync = true; save();');
  const n = window.eval('state.cards.length');
  window.dispatchEvent(new window.StorageEvent('storage', { key: 'huake_data_v1', newValue: JSON.stringify(other) }));
  ok(window.eval('state.cards.length') === n, '本标签有未传改动时不覆盖');
}

// ---- 2i) 存储用量显示（settings.html） ----
console.log('\n=== 本地存储用量显示 ===');
{
  const { window } = loadPage('settings.html');
  const D = window.document;
  window.eval('state.cards=[{id:"c1",name:"卡",total:10,used:0,lowWarn:2,note:"",color:"#4f7cff",createdAt:"",image:"",receipts:[],folderId:"",kind:"lesson",price:0,purchasedAt:""}]; save();');
  window.__T.render();
  const t = D.getElementById('storage-usage').textContent;
  ok(/本地存储已用 \d+\.\d{2} MB/.test(t), '设置页显示本地存储用量：' + t);
}

// ---- 2j) 图片上传压缩（桩 FileReader；jsdom 无 canvas，验证回退路径） ----
console.log('\n=== 图片上传压缩 ===');
{
  const { window } = loadPage('cards.html');
  // 同步桩 FileReader：readAsDataURL 立即回调
  window.FileReader = function () {
    var self = this;
    this.readAsDataURL = function () {
      self.result = 'data:image/png;base64,STUB';
      if (self.onload) self.onload();
    };
  };
  window.__T.readCardImage({ name: 'small.png', type: 'image/png', size: 1000 });
  ok(window.eval('cardImageData') === 'data:image/png;base64,STUB', '小图（<300KB）直接采用原图');
  window.__T.readCardImage({ name: 'big.png', type: 'image/png', size: 500000 });
  ok(window.eval('cardImageData') === 'data:image/png;base64,STUB', '大图在无 canvas 环境下回退原图且不报错');
}

// ---- 3) 缺元素页面：settings.html 调用 render 不报错 ----
console.log('\n=== 缺元素页面：settings.html 安全渲染 ===');
{
  const { window, errors } = loadPage('settings.html');
  let threw = null;
  try {
    // 站点实际走 render() 分发器（按元素是否存在分别调用），直接在缺元素页调用它应安全
    window.__T.render();
  } catch (e) { threw = e.message; }
  ok(!threw, 'settings 页面（缺 #cards/#history 等）调用 render() 分发器安全跳过' + (threw ? '：' + threw : ''));
  ok(errors.length === 0, 'settings 页面全程无报错' + (errors.length ? ' ' + JSON.stringify(errors) : ''));
}

// ---- 4) 云端同步：桩版 WorkBuddyCloud（存储通道）+ 发布域名 ----
console.log('\n=== 云端同步（桩版 SDK，模拟发布域名）===');
const HOST = 'https://huake-counter.app.workbuddy.host';
const STATE_PATH = 'users/uid-1/huake/state.json';
const SESSION = { user: { id: 'uid-1', name: '豆浆' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function pad2(n) { return ('0' + n).slice(-2); }
function thisMonth() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
function basePayload(extra) {
  var p = {
    cards: [{ id: 'c9', name: '云端卡', total: 20, used: 3, lowWarn: 2, note: '', color: '#4f7cff', createdAt: '', image: '', receipts: [] }],
    history: [], attachments: [],
    operators: [{ id: 'op_default', name: '默认' }],
    meta: { lastAutoBackupMonth: thisMonth(), theme: 'light', currentOperator: 'op_default', syncedAt: '', pendingSync: false }
  };
  if (extra) Object.assign(p, extra);
  return p;
}
function seedLocal(win, extra) {
  var data = Object.assign({
    cards: [{ id: 'c1', name: '本地卡', total: 10, used: 1, lowWarn: 2, note: '', color: '#4f7cff', createdAt: '', image: '', receipts: [] }],
    history: [], attachments: [],
    operators: [{ id: 'op_default', name: '默认' }],
    meta: { lastAutoBackupMonth: thisMonth(), theme: 'light', currentOperator: 'op_default', syncedAt: '', pendingSync: false }
  }, extra || {});
  win.localStorage.setItem('huake_data_v1', JSON.stringify(data));
}
// 桩版云端存储：虚拟文件表 + 服务器时钟；opts 可在测试中就地修改（如清掉 verifyOtpError）
function makeStub(opts) {
  opts = opts || {};
  var serverClock = Date.parse('2026-10-18T10:00:00Z');
  var store = {};   // path -> { text, updatedAt }
  var calls = {
    uploads: [], updates: [], infos: 0, downloads: 0,
    infoFailLeft: opts.infoFailTimes || 0, uploadFailLeft: opts.uploadFailTimes || 0,
    getSession: 0, getUser: 0, sendOtp: [], verifyOtp: [], oauth: [], wechatCb: 0, wbCb: 0, signOut: 0, fetches: []
  };
  function notFound() { return { status: 404, message: 'Object not found' }; }
  function tick() { serverClock += 1000; return new Date(serverClock).toISOString(); }
  if (opts.cloudFile) store[STATE_PATH] = { text: JSON.stringify(opts.cloudFile), updatedAt: tick() };
  var storage = {
    userPath: function (uid, rel) { return 'users/' + uid + '/' + rel; },
    upload: function (p, body) {
      calls.uploads.push({ path: p, body: String(body) });
      if (calls.uploadFailLeft > 0) { calls.uploadFailLeft--; return Promise.resolve({ data: null, error: { status: 409, message: 'exists' } }); }
      store[p] = { text: String(body), updatedAt: tick() };
      return Promise.resolve({ data: { path: p }, error: null });
    },
    update: function (p, body) {
      calls.updates.push({ path: p, body: String(body) });
      if (!store[p]) return Promise.resolve({ data: null, error: notFound() });
      store[p] = { text: String(body), updatedAt: tick() };
      return Promise.resolve({ data: { path: p }, error: null });
    },
    download: function (p) {
      calls.downloads++;
      if (opts.downloadError) return Promise.resolve({ data: null, error: opts.downloadError });
      var f = store[p];
      if (!f) return Promise.resolve({ data: null, error: notFound() });
      return Promise.resolve({ data: { text: function () { return Promise.resolve(f.text); } }, error: null });
    },
    info: function (p) {
      calls.infos++;
      if (calls.infoFailLeft > 0) { calls.infoFailLeft--; return Promise.resolve({ data: null, error: { status: 500, message: 'boom' } }); }
      var f = store[p];
      if (!f) return Promise.resolve({ data: null, error: notFound() });
      return Promise.resolve({ data: { updatedAt: f.updatedAt, size: f.text.length }, error: null });
    }
  };
  var auth = {
    getSession: function () { calls.getSession++; return Promise.resolve({ data: opts.session || null, error: null }); },
    getUser: function () { calls.getUser++; var u = opts.user || (opts.session && opts.session.user) || { id: 'uid-1', name: '豆浆' }; return Promise.resolve({ data: u, error: null }); },
    sendOtp: function (a) { calls.sendOtp.push(a); return opts.sendOtpError ? Promise.resolve({ data: null, error: opts.sendOtpError }) : Promise.resolve({ data: { verificationId: 'vid-1', isExistingUser: false }, error: null }); },
    verifyOtp: function (a) { calls.verifyOtp.push(a); return opts.verifyOtpError ? Promise.resolve({ data: null, error: opts.verifyOtpError }) : Promise.resolve({ data: { user: opts.user || { id: 'uid-1', name: '豆浆' } }, error: null }); },
    signInWithOAuth: function (a) { calls.oauth.push(a); return opts.oauthError ? Promise.resolve({ data: null, error: opts.oauthError }) : Promise.resolve({ data: { url: HOST + '/oauth/fake' }, error: null }); },
    handleWechatWebCallback: function () { calls.wechatCb++; return opts.wechatCbError ? Promise.resolve({ data: null, error: opts.wechatCbError }) : Promise.resolve({ data: { user: opts.user || { id: 'uid-1', name: '豆浆' } }, error: null }); },
    handleWorkBuddyCallback: function () { calls.wbCb++; return Promise.resolve({ data: { user: opts.user || { id: 'uid-1', name: '豆浆' } }, error: null }); },
    signOut: function () { calls.signOut++; return Promise.resolve({ error: null }); },
    onAuthStateChange: function () {}
  };
  var cloud = { auth: auth, storage: storage };
  return {
    calls: calls, cloud: cloud, opts: opts, store: store,
    // 模拟另一台设备写入：盖写文件并推一个更新的版本戳
    putRemote: function (payload) {
      var p = JSON.parse(JSON.stringify(payload));
      p.meta = p.meta || {};
      p.meta.syncedAt = tick();
      store[STATE_PATH] = { text: JSON.stringify(p), updatedAt: tick() };
    },
    readRemote: function () { var f = store[STATE_PATH]; return f ? JSON.parse(f.text) : null; }
  };
}
function loadCloudPage(page, opts) {
  opts = opts || {};
  var html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  var vc = new VirtualConsole();
  var jsdomErrors = [];
  vc.on('jsdomError', function (e) { jsdomErrors.push(e.message || String(e)); });
  var dom = new JSDOM(html, { runScripts: 'outside-only', url: opts.url || (HOST + '/' + page), pretendToBeVisual: true, virtualConsole: vc });
  var errors = [];
  dom.window.addEventListener('error', function (e) { errors.push(e.message || String(e.error)); });
  dom.window.PUBLIC_CLOUD_CONFIG = {
    resourceId: 'wbcs_test',
    endpoint: HOST,
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_test'
  };
  if (opts.cloudEnabled !== undefined) dom.window.PUBLIC_CLOUD_CONFIG.enabled = opts.cloudEnabled;
  var stub = makeStub(opts);
  dom.window.WorkBuddyCloud = { createWorkBuddyCloud: function () { return stub.cloud; } };
  dom.window.fetch = function (u, init) {
    stub.calls.fetches.push({ url: String(u), method: (init && init.method) || 'GET' });
    return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.reject(new Error('not json')); } });
  };
  if (opts.seed) seedLocal(dom.window, opts.seed === true ? null : opts.seed);
  try { dom.window.eval(JS); } catch (e) { errors.push('eval: ' + e.message); }
  return { dom: dom, window: dom.window, errors: errors, stub: stub, jsdomErrors: jsdomErrors };
}

(async function () {
  // A) 未登录 → 登录门
  {
    const { window, errors, stub } = loadCloudPage('index.html', {});
    await sleep(80);
    const gate = window.document.getElementById('cloud-gate');
    ok(!!gate && !gate.classList.contains('hidden'), '云模式：未登录时显示登录门');
    ok(stub.calls.getSession === 1, '云模式：启动时查询过一次会话');
    ok(stub.calls.fetches.length === 1 && stub.calls.fetches[0].method === 'GET', '云模式：只探测局域网接口，未走局域网数据通道');
    ok(stub.calls.downloads === 0, '未登录不读云端文件');
    ok(errors.length === 0, '云模式启动无报错' + (errors.length ? ' ' + JSON.stringify(errors) : ''));
    ok(!!window.document.getElementById('gate-wechat') && !!window.document.getElementById('gate-phone'), '登录门含微信登录与手机验证码入口');
  }

  // B) 已登录 + 云端有文件 → 采用
  {
    const { window, errors, stub } = loadCloudPage('index.html', { session: SESSION, cloudFile: basePayload() });
    await sleep(80);
    const gate = window.document.getElementById('cloud-gate');
    ok(!gate || gate.classList.contains("hidden"), '有会话：登录门已隐藏');
    ok(window.eval('state.cards.length') === 1 && window.eval('state.cards[0].name') === '云端卡', '已采用云端数据');
    ok(window.__T.cloud().path === STATE_PATH, '云端文件路径按账号私有（users/<uid>/huake/state.json）');
    ok(window.__T.cloud().exists === true, '标记云端文件已存在');
    ok(stub.calls.downloads === 1, '启动时下载一次云端文件');
    ok(stub.calls.uploads.length === 0 && stub.calls.updates.length === 0, '采用云端后不产生写入');
    const badge = window.document.getElementById('sync-badge');
    ok(badge && badge.textContent.indexOf('云同步') >= 0, '角标显示云同步已开启');
    ok(errors.length === 0, '登录后启动无报错' + (errors.length ? ' ' + JSON.stringify(errors) : ''));
  }

  // B2) 设置页账号面板
  {
    const { window } = loadCloudPage('settings.html', { session: SESSION, cloudFile: basePayload() });
    await sleep(80);
    const p = window.document.getElementById('account-panel');
    ok(p && !p.classList.contains('hidden'), '设置页：登录后显示账号面板');
    ok(window.document.getElementById('account-name').textContent.indexOf('豆浆') >= 0, '账号面板显示当前账号');
  }

  // C) 云端无文件 + 本机有数据 → 首次登录迁移
  {
    const { window, stub } = loadCloudPage('index.html', { session: SESSION, seed: true });
    await sleep(80);
    ok(stub.calls.uploads.length === 1, '首次登录：本机数据 upload 迁移上云');
    ok(stub.calls.uploads[0].path === STATE_PATH, '迁移到账号私有路径');
    const up = JSON.parse(stub.calls.uploads[0].body);
    ok(up.cards[0].name === '本地卡', '迁移内容是本机数据');
    ok(up.meta.pendingSync === undefined, '待传标记不写入云端');
    ok(typeof up.meta.syncedAt === 'string' && up.meta.syncedAt.length > 0, '版本戳随数据上云');
    ok(window.__T.cloud().exists === true, '迁移后标记云端文件已存在');
  }

  // D) 编辑 → 防抖推送
  {
    const { window, stub } = loadCloudPage('cards.html', { session: SESSION, cloudFile: basePayload() });
    await sleep(80);
    const u0 = stub.calls.uploads.length;
    window.eval('state.cards[0].used = 9;');
    window.__T.save();
    window.__T.save();
    await sleep(750);
    ok(stub.calls.uploads.length === u0 + 1, '连续保存被防抖成一次推送');
    const body = JSON.parse(stub.calls.uploads[stub.calls.uploads.length - 1].body);
    ok(body.cards[0].used === 9, '推送内容包含最新改动');
    ok(body.meta.pendingSync === undefined, '待传标记不写入云端');
    ok(window.eval('state.meta.pendingSync') === false, '推送成功后清除本机待传标记');
    ok(stub.calls.fetches.every(f => f.method !== 'POST'), '云模式下保存不再请求局域网接口');
  }

  // D2) upload 不被支持（已存在同名文件）→ update 兜底覆盖
  {
    const { window, stub } = loadCloudPage('cards.html', { session: SESSION, cloudFile: basePayload(), uploadFailTimes: 1 });
    await sleep(80);
    window.eval('state.cards[0].used = 7;');
    window.__T.save();
    await sleep(750);
    ok(stub.calls.uploads.length === 1 && stub.calls.updates.length === 1, 'upload 失败后退回 update 覆盖');
    ok(JSON.parse(stub.calls.updates[0].body).cards[0].used === 7, '兜底推送内容正确');
    ok(stub.readRemote().cards[0].used === 7, '云端文件已被更新');
  }

  // E) 云端存储不可用 → 明确报错 + 用户可选择本地
  {
    const { window, stub } = loadCloudPage('index.html', { session: SESSION, downloadError: { status: 500, message: 'storage unavailable' } });
    await sleep(80);
    const gate = window.document.getElementById('cloud-gate');
    ok(!!gate && !gate.classList.contains('hidden'), '存储不可用：显示明确错误而非静默本地');
    ok(gate.textContent.indexOf('云同步暂时连不上') >= 0, '错误文案说明云端暂时连不上');
    const localBtn = window.document.getElementById('gate-local');
    ok(!!localBtn, '提供「先本地使用」出口');
    localBtn.click();
    ok(gate.classList.contains('hidden'), '点击后回到应用');
    ok(window.__T.cloud().mode === false, '已降级为本地模式');
    ok(window.eval('state.meta.pendingSync') === true, '降级前标记本机改动，之后登录可补传');
    const badge = window.document.getElementById('sync-badge');
    ok(badge && badge.textContent.indexOf('本地模式') >= 0, '角标显示本地模式');
  }

  // F) 微信授权回调
  {
    const { window, stub } = loadCloudPage('index.html', { session: SESSION, cloudFile: basePayload(), url: HOST + '/index.html?code=abc&state=xyz&provider=wechat' });
    await sleep(80);
    ok(stub.calls.wechatCb === 1, '微信回调被处理一次');
    ok(stub.calls.getSession === 0, '回调路径不重复查会话');
    ok(window.location.search === '', '成功后已清理 URL 中的 code/state/provider');
    ok(window.eval('state.cards[0].name') === '云端卡', '回调登录后同样拉取云端文件');
  }

  // G) 按 provider 分发
  {
    const { window, stub } = loadCloudPage('index.html', { session: SESSION, cloudFile: basePayload(), url: HOST + '/index.html?code=abc&state=xyz&provider=workbuddy' });
    await sleep(80);
    ok(stub.calls.wbCb === 1 && stub.calls.wechatCb === 0, 'provider=workbuddy：只调 WorkBuddy 回调');
  }

  // G2) 回调带 page 参数 → 回跳原页面
  {
    const { window, stub, jsdomErrors } = loadCloudPage('cards.html', { session: SESSION, cloudFile: basePayload(), url: HOST + '/index.html?code=abc&state=xyz&provider=wechat&page=cards.html' });
    await sleep(80);
    ok(stub.calls.wechatCb === 1, '带 page 的回调同样被处理');
    ok(window.location.search.indexOf('code=') < 0 && window.location.search.indexOf('page=cards.html') >= 0, '清理回调参数但保留页面参数');
    ok(jsdomErrors.some(m => /not implemented/i.test(m)), '已尝试跳回登录前所在页面');
  }

  // H) 手机验证码全流程
  {
    const { window, stub } = loadCloudPage('index.html', { session: null, verifyOtpError: { message: '验证码错误' } });
    await sleep(80);
    const D = window.document;
    D.getElementById('gate-phone').value = '138123';
    D.getElementById('gate-code').click();
    ok(D.getElementById('gate-phone-err').textContent.indexOf('11 位手机号') >= 0, '手机号不足 11 位：提示且不发送');
    ok(stub.calls.sendOtp.length === 0, '非法手机号未触发 sendOtp');
    D.getElementById('gate-phone').value = '13812345678';
    D.getElementById('gate-code').click();
    await sleep(30);
    ok(stub.calls.sendOtp.length === 1 && stub.calls.sendOtp[0].phone === '13812345678', 'sendOtp 收到正确手机号');
    ok(D.getElementById('gate-code').disabled === true, '发送后进入倒计时');
    D.getElementById('gate-otp').value = '000000';
    D.getElementById('gate-login').click();
    await sleep(30);
    ok(D.getElementById('gate-err').textContent.length > 0, '验证码错误：显示错误');
    ok(!D.getElementById('cloud-gate').classList.contains('hidden'), '验证码错误时停留在登录门');
    ok(stub.calls.sendOtp.length === 1, '重试验证码不重新发送');
    stub.opts.verifyOtpError = null;
    D.getElementById('gate-otp').value = '123456';
    D.getElementById('gate-login').click();
    await sleep(80);
    ok(stub.calls.verifyOtp.length === 2, '第二次提交复用同一验证码挑战');
    ok(D.getElementById('cloud-gate').classList.contains('hidden'), '验证通过后进入应用');
    ok(stub.calls.getUser === 1, '登录后拉取用户信息');
    ok(stub.calls.downloads === 1, '登录后读取云端文件');
  }

  // I) 微信登录按钮
  {
    const { window, stub, jsdomErrors } = loadCloudPage('index.html', { session: null });
    await sleep(80);
    window.document.getElementById('gate-wechat').click();
    await sleep(30);
    ok(stub.calls.oauth.length === 1 && stub.calls.oauth[0].provider === 'wechat', '微信按钮调用 signInWithOAuth(provider=wechat)');
    ok(stub.calls.oauth[0].redirectTo.indexOf(HOST) === 0, 'redirectTo 指向发布域名根路径');
    ok(jsdomErrors.some(m => /not implemented/i.test(m)), '点击后跳转微信授权页');
  }

  // J) 非发布域名不碰云
  {
    const { window, stub } = loadCloudPage('index.html', { url: 'http://192.168.1.13:8000/index.html' });
    await sleep(80);
    ok(stub.calls.getSession === 0, '非发布域名：不初始化云端');
    const badge = window.document.getElementById('sync-badge');
    ok(badge && badge.textContent.indexOf('本地模式') >= 0, '非发布域名：按本地模式运行');
  }

  // K) 云同步开关显式关闭 → 本地模式
  {
    const { window, stub } = loadCloudPage('index.html', { cloudEnabled: false });
    await sleep(80);
    ok(stub.calls.getSession === 0 && !window.document.getElementById('cloud-gate'), '开关关闭：不初始化云端、不弹登录门');
    const badge = window.document.getElementById('sync-badge');
    ok(badge && badge.textContent.indexOf('本地模式') >= 0, '开关关闭：按本地模式运行');
  }

  // L) 轮询：远端有新改动 → 采用并提示
  {
    const { window, stub } = loadCloudPage('index.html', { session: SESSION, cloudFile: basePayload() });
    await sleep(80);
    stub.putRemote(basePayload({ cards: [{ id: 'c10', name: '手机新卡', total: 8, used: 1, lowWarn: 1, note: '', color: '#e5484d', createdAt: '', image: '', receipts: [] }] }));
    window.__T.cloudPull();
    await sleep(50);
    ok(window.eval('state.cards[0].name') === '手机新卡', '轮询采用其他设备的新改动');
    ok(window.document.getElementById('toast').textContent.indexOf('已同步') >= 0, '采用远端改动时给出提示');
    ok(window.__T.cloud().lastTs > 0, '轮询后版本线已更新');
  }

  // M) 轮询：文件无变化 → 不下载（省流量）
  {
    const { window, stub } = loadCloudPage('index.html', { session: SESSION, cloudFile: basePayload() });
    await sleep(80);
    const d0 = stub.calls.downloads, i0 = stub.calls.infos;
    window.__T.cloudPull();
    await sleep(50);
    ok(stub.calls.downloads === d0, '文件无变化：不重复下载');
    ok(stub.calls.infos === i0 + 1, '文件无变化：只做一次轻量 info 探测');
  }

  // N) 轮询：本机有未传改动 → 不被远端覆盖
  {
    const { window, stub } = loadCloudPage('index.html', { session: SESSION, cloudFile: basePayload() });
    await sleep(80);
    window.eval('state.cards[0].used = 15; state.meta.pendingSync = true;');
    stub.putRemote(basePayload({ cards: [{ id: 'c11', name: '别处改动', total: 8, used: 1, lowWarn: 1, note: '', color: '#4f7cff', createdAt: '', image: '', receipts: [] }] }));
    window.__T.cloudPull();
    await sleep(50);
    ok(window.eval('state.cards[0].used') === 15, '本机有未传改动时轮询不覆盖本机');
  }

  // O) info 连续失败 → 退回每轮直读
  {
    const { window, stub } = loadCloudPage('index.html', { session: SESSION, cloudFile: basePayload(), infoFailTimes: 99 });
    await sleep(80);
    const d0 = stub.calls.downloads;
    window.__T.cloudPull();
    await sleep(50);
    ok(stub.calls.downloads === d0 + 1, 'info 探测失败：当轮直接读取文件');
    ok(window.__T.cloud().noInfo === false, '首次探测失败仍保留 info 通道');
    window.__T.cloudPull();
    await sleep(50);
    ok(stub.calls.downloads === d0 + 2, 'info 持续失败：继续每轮直读');
    ok(window.__T.cloud().noInfo === true, '连续失败后标记 info 不可用');
  }

  // P) 退出登录 → 重置并回到登录门
  {
    const { window, stub } = loadCloudPage('settings.html', { session: SESSION, cloudFile: basePayload() });
    await sleep(80);
    window.__T.cloudLogout();
    await sleep(50);
    ok(stub.calls.signOut === 1, '退出登录调用 signOut');
    ok(window.__T.cloud().user === null && window.__T.cloud().path === null, '退出后清空账号与云端路径');
    const gate = window.document.getElementById('cloud-gate');
    ok(!!gate && !gate.classList.contains('hidden'), '退出后重新显示登录门');
    const p = window.document.getElementById('account-panel');
    ok(p && p.classList.contains('hidden'), '退出后账号面板隐藏');
  }

  console.log('\n----------------------------------------');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  if (failMsgs.length) console.log('失败项:\n - ' + failMsgs.join('\n - '));
  process.exit(fail === 0 ? 0 : 1);
})();

