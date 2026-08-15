// dsh-native-memory — Client half: the read-only memory browser page.
//
// This file is a CLASSIC script, not an ES module: the harness's client
// module loader executes it in the browser and the factory below receives a
// synchronous `require` for modules like `react`. It is authored in plain
// JavaScript (copied verbatim to lib/client.js by scripts/build-client.mjs —
// tsdown never bundles it).
//
// The page registers into the `settings.section` slot and reads the host
// half's read-only JSON route GET /dsh-native-memory/facts. The page never
// writes: deletion instructions are copied as a `memory_forget` tool call for
// the chat, where the human approval gate decides.
window.__ModuleLoader__.load({
  id: 'dsh-native-memory',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    function api() {
      return fetch('/dsh-native-memory/facts').then((res) =>
        res.json().catch(() => ({})).then((data) => {
          if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status)
          return data
        }),
      )
    }

    function MemoryPage() {
      const [facts, setFacts] = React.useState([])
      const [query, setQuery] = React.useState('')
      const [error, setError] = React.useState('')
      const [copied, setCopied] = React.useState('')

      React.useEffect(() => {
        let alive = true
        api()
          .then((data) => {
            if (alive) setFacts(Array.isArray(data.facts) ? data.facts : [])
          })
          .catch((err) => {
            if (alive) setError(String((err && err.message) || err))
          })
        return () => {
          alive = false
        }
      }, [])

      const folded = query.trim().toLowerCase()
      const visible = folded === ''
        ? facts
        : facts.filter((fact) =>
            String(fact.text).toLowerCase().includes(folded)
            || String(fact.workspace).toLowerCase().includes(folded)
            || (Array.isArray(fact.tags) && fact.tags.some((tag) => String(tag).toLowerCase().includes(folded))))

      const copyForget = (fact) => {
        const command = 'memory_forget id: "' + fact.id + '"'
        const done = () => setCopied(fact.id)
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(command).then(done, done)
        } else {
          done()
        }
      }

      const rows = visible.map((fact) =>
        React.createElement(
          'div',
          {
            key: fact.id,
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: '10px',
              padding: '10px 12px',
              border: '1px solid rgba(128, 128, 128, 0.35)',
              borderRadius: '8px',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } },
            React.createElement('div', null, String(fact.text)),
            React.createElement(
              'div',
              { style: { fontSize: '12px', opacity: 0.7 } },
              '[' + String(fact.kind) + '] '
                + (Array.isArray(fact.tags) && fact.tags.length > 0 ? '#' + fact.tags.join(' #') + ' · ' : '')
                + String(fact.workspace) + ' · session ' + String(fact.sessionId) + '#' + String(fact.seq),
            ),
          ),
          React.createElement(
            'button',
            { onClick: () => copyForget(fact), style: { flexShrink: 0 } },
            '复制删除指令',
          ),
        ),
      )

      return React.createElement(
        'div',
        { style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' } },
        React.createElement('div', { style: { fontWeight: 600 } }, '记忆 · dsh-native-memory(只读浏览)'),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          React.createElement('input', {
            value: query,
            onChange: (ev) => setQuery(ev.target.value),
            placeholder: '按文本 / 标签 / 工作区过滤…',
            style: { flex: 1 },
          }),
        ),
        error ? React.createElement('div', { style: { color: '#e06c75' } }, error) : null,
        copied
          ? React.createElement(
              'div',
              { style: { fontSize: '12px', opacity: 0.8 } },
              '已复制 memory_forget 指令 —— 在对话中粘贴执行,由人工审批后删除。',
            )
          : null,
        visible.length === 0
          ? React.createElement('div', { style: { opacity: 0.6 } }, '暂无记忆。让 Agent 用 memory_remember 记录、memory_recall 回忆。')
          : rows,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'dsh-native-memory', order: 30, label: () => '记忆' },
          () => React.createElement(MemoryPage, null),
        ),
      )
    }

    exports.name = 'dsh-native-memory'
    // The client fiber's dependencies come from the MODULE EXPORT (not the
    // package.json dsh.client metadata): without inject, the fiber activates
    // on the first round and ctx.get('slots') is undefined — the page would
    // never register.
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
