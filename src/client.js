window.__ModuleLoader__.load({
  id: 'dsh-flavor-memory',
  factory(require) {
    const react = require('react');
    const { useEffect, useRef, useState } = react;
    const { jsx: h, jsxs } = require('react/jsx-runtime');

    const css = `
      .fm-setting { display:flex; flex-direction:column; gap:14px; min-height:520px; color:inherit; }
      .fm-setting-header { display:flex; align-items:center; justify-content:space-between; gap:16px; }
      .fm-setting-title { margin:0; font-size:18px; font-weight:600; color:inherit; }
      .fm-setting-note { margin:4px 0 0; opacity:.72; font-size:12px; line-height:1.6; color:inherit; }
      .fm-setting-actions { display:flex; gap:8px; flex-wrap:wrap; }
      .fm-setting button { font:inherit; cursor:pointer; border:1px solid var(--dsh-border,#d8e1df); background:var(--dsh-surface,#ffffff); color:inherit; border-radius:8px; padding:7px 11px; transition:background .15s,border-color .15s; }
      .fm-setting button:hover { background:#eef7f4; border-color:rgba(15,122,104,.35); }
      .fm-setting button.primary { background:#0f7a68; border-color:#0f7a68; color:#ffffff; font-weight:650; }
      .fm-setting button.primary:hover { background:#0b6656; border-color:#0b6656; }
      .fm-setting-frame { color-scheme:light; width:100%; min-height:680px; border:1px solid var(--dsh-border,#d8e1df); border-radius:10px; background:#f5f7f6; box-shadow:0 8px 28px rgba(34,59,52,.06); }
      .fm-setting-error { color:#b33f3f; font-size:12px; }
    `;
    function installStyle() {
      if (document.getElementById('dsh-flavor-memory-setting-style')) return;
      const style = document.createElement('style');
      style.id = 'dsh-flavor-memory-setting-style';
      style.textContent = css;
      document.head.appendChild(style);
    }
    function FlavorMemorySettings() {
      const frame = useRef(null);
      const [status, setStatus] = useState('正在加载控制台…');
      const [failed, setFailed] = useState(false);
      useEffect(() => { installStyle(); }, []);
      useEffect(() => {
        const node = frame.current;
        if (!node) return;
        const timer = setTimeout(() => setStatus(current => current === '正在加载控制台…' ? '控制台加载较慢，可直接在右侧打开。' : current), 4000);
        const loaded = () => { clearTimeout(timer); setStatus('控制台已加载'); setFailed(false); };
        const errored = () => { clearTimeout(timer); setStatus('无法加载内嵌控制台'); setFailed(true); };
        node.addEventListener('load', loaded, { once:true });
        node.addEventListener('error', errored, { once:true });
        return () => { clearTimeout(timer); node.removeEventListener('load', loaded); node.removeEventListener('error', errored); };
      }, []);
      const open = () => window.open('/flavor-memory/studio', '_blank', 'noopener');
      const reload = () => { setFailed(false); setStatus('正在重新加载…'); if (frame.current) frame.current.src = '/flavor-memory/studio?reload=' + Date.now(); };
      return jsxs('div', { className:'fm-setting', children: [
        jsxs('div', { className:'fm-setting-header', children: [
          jsxs('div', { children: [
            h('h2', { className:'fm-setting-title', children:'角色记忆' }),
            h('p', { className:'fm-setting-note', children:'角色卡、世界书、示例对话、动态演化与注入预览。数据只保存在本机。' }),
          ] }),
          jsxs('div', { className:'fm-setting-actions', children: [
            h('button', { type:'button', onClick:reload, children:'重新加载' }),
            h('button', { className:'primary', type:'button', onClick:open, children:'独立窗口打开' }),
          ] }),
        ] }),
        h('iframe', { ref:frame, className:'fm-setting-frame', src:'/flavor-memory/studio', title:'Flavor Memory 角色控制台' }),
        h('div', { className: failed ? 'fm-setting-error' : 'fm-setting-note', role:'status', children: status + (failed ? ' 请确认 DSH Web 宿主已加载插件路由，或使用独立窗口打开。' : '') }),
      ] });
    }

    const name = 'flavor-memory';
    const inject = ['slots'];
    function apply(ctx) {
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name:'settings.section', id:'flavor-memory-config', order:42, label:() => '角色记忆' },
          FlavorMemorySettings,
        );
      });
    }
    return { apply, inject, name };
  },
});


