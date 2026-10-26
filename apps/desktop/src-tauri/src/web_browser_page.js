(() => {

  function applyScrollbars() {
    const style = document.createElement('style');
    style.id = 'novel-library-scrollbars';
    style.textContent = `
      * { scrollbar-width: auto !important; scrollbar-color: auto !important; }
      *::-webkit-scrollbar { width: 6px !important; height: 6px !important; background: transparent !important; }
      *::-webkit-scrollbar-track, *::-webkit-scrollbar-corner { background: transparent !important; }
      *::-webkit-scrollbar-track { margin-block: 4px; }
      *::-webkit-scrollbar-thumb {
        min-height: 30px !important;
        border: 1px solid transparent !important;
        border-radius: 999px !important;
        background-color: #b7b8bb !important;
        background-clip: padding-box !important;
        transition: background-color 160ms ease;
      }
      *::-webkit-scrollbar-thumb:hover, *::-webkit-scrollbar-thumb:active { background-color: #95979b !important; }
      *::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; }
    `;
    (document.head || document.documentElement).append(style);
  }
  if (document.documentElement) applyScrollbars();
  else document.addEventListener('DOMContentLoaded', applyScrollbars, { once: true });

})();
