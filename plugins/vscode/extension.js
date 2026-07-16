const vscode = require('vscode')
const { request } = require('./bridge')

function html() {
  return `<!doctype html><html><head><meta charset="UTF-8"><style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px;line-height:1.8}
  header{display:flex;gap:8px;align-items:center;position:sticky;top:0;background:var(--vscode-editor-background);padding-bottom:8px}
  select,button{color:inherit;background:var(--vscode-button-background);border:0;padding:5px 8px}
  #content{margin-top:18px;white-space:pre-wrap;font-size:16px;line-height:2;min-height:190px}
  #content p{margin:0;min-height:2em}.meta{opacity:.7;font-size:11px}
  </style></head><body><header><select id="books"></select><select id="chapters"></select><button id="prev">上一章</button><button id="next">下一章</button></header><div id="title"></div><main id="content">正在读取书架...</main><div class="meta" id="meta"></div><script>
  const vscode=acquireVsCodeApi();let books=[],chapters=[],book,chapter,lineStart=0;
  const booksEl=document.getElementById('books'), chaptersEl=document.getElementById('chapters'), content=document.getElementById('content');
  function send(type,data){vscode.postMessage({type,data})}
  function render(){if(!chapter)return;const lines=(chapter.contentText||chapter.content).split(/\\n+/);lineStart=Math.max(0,Math.min(lineStart,Math.max(0,lines.length-5)));document.getElementById('title').textContent=chapter.title;content.textContent=lines.slice(lineStart,lineStart+5).join('\\n');document.getElementById('meta').textContent='显示 '+(lineStart+1)+' - '+Math.min(lines.length,lineStart+5)+' 行 · 使用方向键滚动，Ctrl+方向键切换章节';send('progress',{chapterNumber:chapter.number,chapterProgress:lines.length>5?lineStart/(lines.length-5)*100:100})}
  window.addEventListener('message',e=>{const m=e.data;if(m.type==='books'){books=m.data;booksEl.innerHTML=books.map(b=>'<option value="'+b.id+'">'+b.title+'</option>').join('');if(books[0])send('book',books[0].id)}if(m.type==='chapters'){chapters=m.data;chaptersEl.innerHTML=chapters.map(c=>'<option value="'+c.number+'">'+c.title+'</option>').join('');if(chapters[0])send('chapter',chapters[0].number)}if(m.type==='chapter'){chapter=m.data;lineStart=0;render()}if(m.type==='line'){lineStart+=m.data.direction*(m.data.page?5:1);render()}})
  booksEl.onchange=()=>send('book',booksEl.value);chaptersEl.onchange=()=>send('chapter',Number(chaptersEl.value));document.getElementById('prev').onclick=()=>send('move',-1);document.getElementById('next').onclick=()=>send('move',1);document.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='PageDown')send('line',{direction:1,page:e.key==='PageDown'});if(e.key==='ArrowUp'||e.key==='PageUp')send('line',{direction:-1,page:e.key==='PageUp'});if(e.ctrlKey&&e.key==='ArrowRight')send('move',1);if(e.ctrlKey&&e.key==='ArrowLeft')send('move',-1)});send('load');
  </script></body></html>`
}

function activate(context) {
  let panel
  let currentBook
  let currentChapterIndex = 0
  const openReader = () => {
    panel = vscode.window.createWebviewPanel('novelLibraryReader', '小说阅读', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true })
    panel.webview.html = html()
    panel.webview.onDidReceiveMessage(async message => {
      try {
        if (message.type === 'load') panel.webview.postMessage({ type: 'books', data: await request('/v1/books') })
        if (message.type === 'book') { currentBook = message.data; currentChapterIndex = 0; panel.webview.postMessage({ type: 'chapters', data: await request(`/v1/books/${encodeURIComponent(currentBook)}/chapters`) }) }
        if (message.type === 'chapter') panel.webview.postMessage({ type: 'chapter', data: await request(`/v1/books/${encodeURIComponent(currentBook)}/chapters/${message.data}`) })
        if (message.type === 'line') panel.webview.postMessage({ type: 'line', data: message.data })
        if (message.type === 'progress') await request('/v1/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId: currentBook, chapterNumber: message.data.chapterNumber, chapterProgress: message.data.chapterProgress }) })
        if (message.type === 'move') { const list = await request(`/v1/books/${encodeURIComponent(currentBook)}/chapters`); currentChapterIndex = Math.max(0, Math.min(list.length - 1, currentChapterIndex + message.data)); panel.webview.postMessage({ type: 'chapter', data: await request(`/v1/books/${encodeURIComponent(currentBook)}/chapters/${list[currentChapterIndex].number}`) }) }
      } catch (error) { vscode.window.showErrorMessage(`小说 Bridge: ${error.message}`) }
    }, undefined, context.subscriptions)
  }
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openReader', openReader))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openDesktop', async () => { try { await vscode.env.openExternal(vscode.Uri.parse('novellibrary://open')) } catch (error) { vscode.window.showErrorMessage(error.message) } }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.importFile', async uri => {
    const file = uri || vscode.window.activeTextEditor?.document.uri
    if (!file) return
    try { await request('/v1/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file.fsPath }) }); vscode.window.showInformationMessage('已发送到小说书库导入队列') } catch (error) { vscode.window.showErrorMessage(`导入失败: ${error.message}`) }
  }))
}

module.exports = { activate, deactivate() {} }
