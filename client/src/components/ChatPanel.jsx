import { useEffect, useMemo, useRef, useState } from 'react';
import { PLAYER_EMOJI } from '../utils.js';

const QUICK = [
  { id: 'langxian', label: '浪险' },
  { id: 'mengmeng', label: '猛猛呐' },
  { id: 'nieyige', label: '捏一个吉' },
  { id: 'maiLanghua', label: '迈浪话' },
  { id: 'sanpu', label: '散谱母落' },
];

// 右栏：房间邀请信息 + 消息流（系统播报/玩家聊天）+ 聊天输入与快捷短语
export default function ChatPanel({ game, send }) {
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const listRef = useRef(null);

  const you = game.you;
  const connected = game.players.filter(p => p.connected).length;
  const inviteLink = `${window.location.origin}${window.location.pathname}?USER=${you.id}`;
  const nicknameOf = (id) => game.players.find(p => p.id === id)?.nickname ?? id;

  const messages = useMemo(() => {
    const merged = [
      ...game.log.map(l => ({ ...l, chatKey: `log-${l.ts}-${Math.random()}` })),
      ...game.chat.map(c => ({ ...c, chatKey: `chat-${c.ts}-${c.from}-${Math.random()}` })),
    ];
    return merged.sort((a, b) => a.ts - b.ts);
  }, [game.log, game.chat]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  function submit() {
    const t = text.trim();
    if (!t) return;
    send({ type: 'chat', text: t });
    setText('');
  }

  function copyLink() {
    navigator.clipboard?.writeText(inviteLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      {/* 顶部：房间邀请信息 */}
      <div className="border-b border-white/10 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-black text-amber-300">房间邀请</span>
          <span className="pill bg-white/10 text-white/70">已加入 {connected}/4</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <input
            readOnly
            value={inviteLink}
            title={inviteLink}
            className="min-w-0 flex-1 truncate rounded-full bg-black/25 px-3 py-1 text-xs font-bold text-white/60 outline-none"
          />
          <button className="btn-gold-sm" onClick={copyLink}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>

      {/* 消息流：系统播报 / 玩家聊天两种样式 */}
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-2">
        {messages.map(m =>
          m.kind === 'SYSTEM' ? (
            <div
              key={m.chatKey}
              className="rounded-xl bg-felt-700/80 px-3 py-1.5 text-xs font-bold text-white/75"
            >
              📣 {m.text}
            </div>
          ) : (
            <div key={m.chatKey} className="flex items-start gap-2">
              <span className="text-lg leading-none">{PLAYER_EMOJI[m.from]}</span>
              <div className="min-w-0">
                <div className="text-xs font-black text-white/60">{nicknameOf(m.from)}</div>
                <div className="break-words rounded-xl bg-white/10 px-2.5 py-1 text-sm font-bold text-white/90">
                  {m.text}
                </div>
              </div>
            </div>
          )
        )}
      </div>

      {/* 底部：快捷短语 + 聊天输入 */}
      <div className="border-t border-white/10 p-2">
        <div className="mb-1.5 flex gap-1.5">
          {QUICK.map(q => (
            <button
              key={q.id}
              className="whitespace-nowrap rounded-full bg-white/10 px-2.5 py-1 text-xs font-bold text-white/75 transition hover:bg-white/20"
              onClick={() => send({ type: 'quickChat', phraseId: q.id })}
            >
              {q.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            maxLength={200}
            placeholder="说点什么…"
            className="min-w-0 flex-1 rounded-full bg-black/25 px-3 py-1.5 text-sm font-bold text-white outline-none placeholder:text-white/30"
          />
          <button className="btn-gold-sm" onClick={submit}>发送</button>
        </div>
      </div>
    </div>
  );
}
