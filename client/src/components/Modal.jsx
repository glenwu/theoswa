import { useEffect } from 'react';
import { createPortal } from 'react-dom';

// 统一模态框：portal 到 body 顶层，覆盖整个页面居中显示。
// 层级由 DOM 挂载顺序决定（最后挂载在最上），不靠 z-index 硬凑。
// - 点遮罩关闭 / ESC 关闭；danger 模式（危险操作确认）必须显式点按钮。
export default function Modal({ title, onClose, children, danger = false, wide = false }) {
  useEffect(() => {
    if (danger) return; // 危险操作确认不允许 ESC 跳过
    const handler = e => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [danger, onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={() => {
        if (!danger) onClose?.();
      }}
    >
      <div
        className={`panel max-h-[88vh] overflow-y-auto p-5 ${wide ? 'w-[min(96%,720px)]' : 'w-[min(92%,480px)]'}`}
        onClick={e => e.stopPropagation()}
      >
        {title && (
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-black text-amber-300">{title}</h2>
            {!danger && (
              <button className="btn-icon" onClick={onClose}>✕</button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}
