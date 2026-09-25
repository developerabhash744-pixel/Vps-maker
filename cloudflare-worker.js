/**
 * Cloudflare Worker for VPS Discord Bot:
 * 1. Discord Gateway & REST API Proxy (bypasses egress firewall)
 * 2. Globally Synchronized In-Browser Web Terminal (sshx.io inspired Infinite Canvas UI)
 */

// =============================================================================
// Durable Object: Global Single Point of Presence per Container
// =============================================================================
export class TerminalSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.agentWs = null;
    this.browserSockets = new Set();
    this.token = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    // 1. Daytona Host Agent Tunnel: /tunnel/:containerName?token=XYZ
    if (url.pathname.startsWith('/tunnel/')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      this.agentWs = server;
      this.token = token;

      server.addEventListener('message', (event) => {
        // Relay output to all connected browser windows
        for (const ws of this.browserSockets) {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(event.data);
            }
          } catch {}
        }
      });

      server.addEventListener('close', () => {
        for (const ws of this.browserSockets) {
          try {
            ws.send('\r\n\x1b[33m[Host disconnected container session]\x1b[0m\r\n');
          } catch {}
        }
        if (this.agentWs === server) {
          this.agentWs = null;
        }
      });

      for (const ws of this.browserSockets) {
        try {
          ws.send('\r\n\x1b[32m[Connected to Container Web Terminal]\x1b[0m\r\n\r\n');
        } catch {}
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Web Terminal UI Route: /term/:containerName?token=XYZ
    if (url.pathname.startsWith('/term/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const name = parts[1] || 'vps';
      const isWs = parts[2] === 'ws' || request.headers.get('Upgrade') === 'websocket';

      // Serve HTML Web Terminal UI (sshx style infinite canvas)
      if (!isWs) {
        return new Response(getTerminalHTML(name, token), {
          headers: { 'Content-Type': 'text/html;charset=utf-8' },
        });
      }

      // Handle Browser WebSocket Connection
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      this.browserSockets.add(server);

      server.addEventListener('message', (event) => {
        try {
          if (this.agentWs && this.agentWs.readyState === WebSocket.OPEN) {
            this.agentWs.send(event.data);
          }
        } catch {}
      });

      server.addEventListener('close', () => {
        this.browserSockets.delete(server);
      });

      if (this.agentWs) {
        try {
          server.send('\r\n\x1b[32m[Connected to Container Web Terminal]\x1b[0m\r\n\r\n');
        } catch {}
      } else {
        try {
          server.send('\r\n\x1b[33m[Waiting for container shell connection...]\x1b[0m\r\n');
        } catch {}
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // =======================================================================
      // 1. Web Terminal & Tunnel Routes (Synchronized via Durable Object)
      // =======================================================================
      if (url.pathname.startsWith('/term/') || url.pathname.startsWith('/tunnel/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        const name = parts[1] || 'default';

        if (env.TERMINAL_SESSION) {
          const id = env.TERMINAL_SESSION.idFromName(name);
          const stub = env.TERMINAL_SESSION.get(id);
          return stub.fetch(request);
        }
      }

      // =======================================================================
      // 2. Discord Gateway & REST API Proxy
      // =======================================================================
      const isWebSocket = request.headers.get('Upgrade') === 'websocket';
      let targetUrl;

      if (isWebSocket) {
        targetUrl = new URL('https://gateway.discord.gg' + url.pathname + url.search);
      } else {
        targetUrl = new URL('https://discord.com' + url.pathname + url.search);
      }

      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('Host', targetUrl.host);
      modifiedHeaders.delete('CF-Connecting-IP');
      modifiedHeaders.delete('CF-Ray');
      modifiedHeaders.delete('X-Forwarded-For');

      const response = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: modifiedHeaders,
        body: isWebSocket || ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'follow',
      });

      if (isWebSocket) {
        return response;
      }

      // Intercept Discord gateway endpoints and rewrite the gateway URL to our Worker
      if (url.pathname.includes('/gateway')) {
        const text = await response.text();
        const rewritten = text.replace(/wss:\/\/gateway\.discord\.gg/g, `wss://${url.host}`);
        const newHeaders = new Headers(response.headers);
        newHeaders.delete('content-length');
        return new Response(rewritten, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }

      return response;
    } catch (err) {
      return new Response('Worker Error: ' + err.message, { status: 500 });
    }
  },
};

function getTerminalHTML(name, token) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${name} — Web Terminal Canvas</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-search@0.15.0/lib/addon-search.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090b10;
      --canvas-dot: rgba(255, 255, 255, 0.12);
      --card-bg: rgba(15, 18, 28, 0.94);
      --card-border: rgba(255, 255, 255, 0.12);
      --header-bg: #131722;
      --accent: #5865F2;
      --accent-hover: #4752c4;
      --success: #00FF88;
      --danger: #FF4444;
      --text: #e6edf3;
      --text-muted: #8b949e;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    
    body {
      background-color: var(--bg);
      background-image: radial-gradient(var(--canvas-dot) 1.2px, transparent 1.2px);
      background-size: 26px 26px;
      font-family: 'Inter', -apple-system, sans-serif;
      color: var(--text);
      height: 100vh;
      width: 100vw;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* Top Navigation Toolbar */
    .toolbar {
      height: 52px;
      background: rgba(15, 18, 28, 0.85);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid var(--card-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 18px;
      z-index: 1000;
    }

    .brand-section {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 15px;
      letter-spacing: -0.2px;
    }

    .vps-tag {
      background: rgba(88, 101, 242, 0.18);
      border: 1px solid rgba(88, 101, 242, 0.4);
      color: #9aa5ff;
      padding: 3px 10px;
      border-radius: 6px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      font-weight: 600;
    }

    .toolbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .btn {
      background: #1c2130;
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }

    .btn:hover {
      background: #252b3d;
      border-color: rgba(255, 255, 255, 0.25);
    }

    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }

    .btn-primary:hover {
      background: var(--accent-hover);
    }

    /* Search Box in Toolbar */
    .search-container {
      display: flex;
      align-items: center;
      background: #141824;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 2px 8px;
      gap: 6px;
    }

    .search-input {
      background: transparent;
      border: none;
      outline: none;
      color: var(--text);
      font-size: 13px;
      font-family: 'JetBrains Mono', monospace;
      width: 140px;
    }

    .search-nav-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 2px;
      font-size: 12px;
    }

    .search-nav-btn:hover { color: #fff; }

    .status-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 500;
      padding: 4px 10px;
      border-radius: 20px;
      background: rgba(0, 255, 136, 0.1);
      border: 1px solid rgba(0, 255, 136, 0.25);
      color: var(--success);
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
    }

    /* Infinite Canvas Viewport */
    #canvas-viewport {
      flex: 1;
      position: relative;
      overflow: hidden;
      cursor: grab;
    }

    #canvas-viewport.panning {
      cursor: grabbing;
    }

    #canvas-world {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      transform-origin: 0 0;
    }

    /* Floating Window Card (sshx style) */
    .terminal-card {
      position: absolute;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(20px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 480px;
      min-height: 320px;
      transition: box-shadow 0.15s ease;
    }

    .terminal-card.active {
      box-shadow: 0 28px 70px rgba(0, 0, 0, 0.8), 0 0 0 1.5px var(--accent);
    }

    /* macOS Window Header */
    .card-header {
      height: 38px;
      background: var(--header-bg);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 14px;
      cursor: move;
    }

    .window-dots {
      display: flex;
      gap: 7px;
      align-items: center;
    }

    .dot {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      cursor: pointer;
    }

    .dot-red { background: #ff5f56; border: 1px solid #e0443e; }
    .dot-yellow { background: #ffbd2e; border: 1px solid #dea123; }
    .dot-green { background: #27c93f; border: 1px solid #1aab29; }

    .card-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .card-tools {
      display: flex;
      gap: 6px;
    }

    .tool-icon {
      color: var(--text-muted);
      cursor: pointer;
      font-size: 13px;
      padding: 3px;
    }

    .tool-icon:hover { color: #fff; }

    /* Terminal Container inside Card */
    .terminal-body {
      flex: 1;
      padding: 8px 12px;
      background: #090b10;
      overflow: hidden;
      user-select: text;
    }

    .terminal-body * { user-select: text; }

    /* Canvas Zoom HUD (Bottom Left) */
    .canvas-hud {
      position: absolute;
      bottom: 20px;
      left: 20px;
      background: rgba(19, 23, 34, 0.9);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(12px);
      border-radius: 8px;
      display: flex;
      align-items: center;
      padding: 4px;
      gap: 4px;
      z-index: 1000;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }

    .hud-btn {
      background: transparent;
      border: none;
      color: var(--text);
      width: 28px;
      height: 28px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-weight: bold;
      font-size: 14px;
    }

    .hud-btn:hover { background: #2b3247; }

    .zoom-text {
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      padding: 0 6px;
      color: var(--text-muted);
      min-width: 45px;
      text-align: center;
    }

    /* Resize handle */
    .resize-handle {
      position: absolute;
      bottom: 2px;
      right: 2px;
      width: 14px;
      height: 14px;
      cursor: nwse-resize;
      opacity: 0.4;
    }
  </style>
</head>
<body>
  <!-- Top Navigation Toolbar -->
  <header class="toolbar">
    <div class="brand-section">
      <div class="logo-badge">
        <span>⚡ NovaCloud Canvas</span>
      </div>
      <span class="vps-tag">${name}</span>
    </div>

    <div class="toolbar-actions">
      <!-- Search inside buffer -->
      <div class="search-container">
        <span style="color: var(--text-muted); font-size: 12px;">🔍</span>
        <input type="text" id="terminal-search" class="search-input" placeholder="Search buffer...">
        <button class="search-nav-btn" id="search-prev" title="Previous match">▲</button>
        <button class="search-nav-btn" id="search-next" title="Next match">▼</button>
      </div>

      <button class="btn btn-primary" id="btn-add-term">
        <span>+</span>
        <span>New Terminal</span>
      </button>

      <button class="btn" id="btn-reset-view" title="Center View">
        <span>🎯 Center View</span>
      </button>

      <div class="status-pill" id="status-pill">
        <div class="status-dot" id="status-dot"></div>
        <span id="status-text">Connecting...</span>
      </div>
    </div>
  </header>

  <!-- Infinite Canvas World -->
  <div id="canvas-viewport">
    <div id="canvas-world">
      <!-- Terminal Window Card -->
      <div class="terminal-card active" id="card-1" style="left: 100px; top: 60px; width: 880px; height: 520px; z-index: 10;">
        <div class="card-header" id="card-1-header">
          <div class="window-dots">
            <div class="dot dot-red" title="Close Window" onclick="removeWindow('card-1')"></div>
            <div class="dot dot-yellow" title="Minimize" onclick="toggleMinimize('card-1')"></div>
            <div class="dot dot-green" title="Maximize / Fill" onclick="maximizeWindow('card-1')"></div>
          </div>
          <div class="card-title">
            <span>root@${name}:~#</span>
          </div>
          <div class="card-tools">
            <span class="tool-icon" title="Clear Buffer" onclick="clearActiveTerminal()">🧹</span>
          </div>
        </div>
        <div class="terminal-body" id="term-container-1"></div>
        <div class="resize-handle" onmousedown="initResize(event, 'card-1')">⋰</div>
      </div>
    </div>

    <!-- Zoom & Pan HUD Controls -->
    <div class="canvas-hud">
      <button class="hud-btn" id="hud-zoom-out" title="Zoom Out">−</button>
      <span class="zoom-text" id="hud-zoom-val">100%</span>
      <button class="hud-btn" id="hud-zoom-in" title="Zoom In">+</button>
      <button class="hud-btn" id="hud-zoom-reset" title="Reset Zoom">↺</button>
    </div>
  </div>

  <script>
    // =========================================================================
    // 1. Infinite Pan & Zoom Engine (sshx.io inspired)
    // =========================================================================
    const viewport = document.getElementById('canvas-viewport');
    const world = document.getElementById('canvas-world');
    const zoomValText = document.getElementById('hud-zoom-val');

    let scale = 1.0;
    let panX = 0;
    let panY = 0;
    let isPanning = false;
    let startX = 0;
    let startY = 0;

    function updateTransform() {
      world.style.transform = \`translate(\${panX}px, \${panY}px) scale(\${scale})\`;
      zoomValText.innerText = Math.round(scale * 100) + '%';
    }

    viewport.addEventListener('mousedown', (e) => {
      // Only pan if clicking on the background canvas, not a terminal card
      if (e.target === viewport || e.target === world) {
        isPanning = true;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        viewport.classList.add('panning');
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!isPanning) return;
      panX = e.clientX - startX;
      panY = e.clientY - startY;
      updateTransform();
    });

    window.addEventListener('mouseup', () => {
      isPanning = false;
      viewport.classList.remove('panning');
    });

    // Zoom on wheel (Ctrl + Wheel or normal canvas wheel)
    viewport.addEventListener('wheel', (e) => {
      if (e.target.closest('.terminal-body')) return; // Allow terminal scroll
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      setZoom(scale * zoomFactor, e.clientX, e.clientY);
    }, { passive: false });

    function setZoom(newScale, originX = window.innerWidth / 2, originY = window.innerHeight / 2) {
      newScale = Math.min(2.0, Math.max(0.4, newScale));
      panX = originX - (originX - panX) * (newScale / scale);
      panY = originY - (originY - panY) * (newScale / scale);
      scale = newScale;
      updateTransform();
    }

    document.getElementById('hud-zoom-in').onclick = () => setZoom(scale * 1.15);
    document.getElementById('hud-zoom-out').onclick = () => setZoom(scale * 0.85);
    document.getElementById('hud-zoom-reset').onclick = () => { scale = 1.0; panX = 0; panY = 0; updateTransform(); };
    document.getElementById('btn-reset-view').onclick = () => { scale = 1.0; panX = 0; panY = 0; updateTransform(); };

    // =========================================================================
    // 2. Terminal Manager & Shared WebSocket Connection
    // =========================================================================
    let highestZ = 10;
    const terminals = {};

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + location.host + '/term/${encodeURIComponent(name)}/ws?token=${encodeURIComponent(token || '')}';
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    const statusText = document.getElementById('status-text');
    const statusDot = document.getElementById('status-dot');
    const statusPill = document.getElementById('status-pill');

    ws.onopen = () => {
      statusText.innerText = 'Connected';
      statusText.style.color = '#00FF88';
      statusDot.style.background = '#00FF88';
      statusPill.style.borderColor = 'rgba(0, 255, 136, 0.4)';
      if (terminals['card-1']) terminals['card-1'].term.focus();
      setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send('\r'); }, 300);
    };

    ws.onmessage = async (e) => {
      let data = '';
      if (typeof e.data === 'string') {
        data = e.data;
      } else if (e.data instanceof ArrayBuffer) {
        data = new TextDecoder().decode(e.data);
      } else if (e.data instanceof Blob) {
        data = await e.data.text();
      } else if (e.data) {
        data = new TextDecoder().decode(e.data);
      }

      if (!data) return;

      // Broadcast output to all terminal windows on canvas
      Object.values(terminals).forEach(({ term }) => {
        term.write(data);
      });
    };

    ws.onclose = () => {
      statusText.innerText = 'Disconnected';
      statusText.style.color = '#FF4444';
      statusDot.style.background = '#FF4444';
      statusPill.style.borderColor = 'rgba(255, 68, 68, 0.4)';
      Object.values(terminals).forEach(({ term }) => {
        term.write('\\r\\n\\x1b[31m[Session Closed]\\x1b[0m\\r\\n');
      });
    };

    ws.onerror = () => {
      statusText.innerText = 'Error';
      statusText.style.color = '#FF4444';
      statusDot.style.background = '#FF4444';
    };

    // Create & initialize terminal instance
    function createTerminalWindow(cardId, mountEl) {
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', Menlo, Monaco, Consolas, monospace",
        theme: {
          background: '#090b10',
          foreground: '#e6edf3',
          cursor: '#5865F2',
          selectionBackground: 'rgba(88, 101, 242, 0.35)',
          black: '#090b10',
          red: '#ff5f56',
          green: '#27c93f',
          yellow: '#ffbd2e',
          blue: '#5865F2',
          magenta: '#b392f0',
          cyan: '#79c0ff',
          white: '#e6edf3',
        },
      });

      const fitAddon = new FitAddon.FitAddon();
      const searchAddon = new SearchAddon.SearchAddon();
      const webLinksAddon = new WebLinksAddon.WebLinksAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(webLinksAddon);

      term.open(mountEl);
      fitAddon.fit();

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      terminals[cardId] = { term, fitAddon, searchAddon };
      makeDraggable(document.getElementById(cardId));
      return terminals[cardId];
    }

    // Initialize initial window
    createTerminalWindow('card-1', document.getElementById('term-container-1'));

    // =========================================================================
    // 3. Search in Terminal
    // =========================================================================
    const searchInput = document.getElementById('terminal-search');
    const searchNextBtn = document.getElementById('search-next');
    const searchPrevBtn = document.getElementById('search-prev');

    searchInput.addEventListener('input', () => {
      const query = searchInput.value;
      Object.values(terminals).forEach(({ searchAddon }) => {
        searchAddon.findNext(query);
      });
    });

    searchNextBtn.onclick = () => {
      const query = searchInput.value;
      if (query) Object.values(terminals).forEach(({ searchAddon }) => searchAddon.findNext(query));
    };

    searchPrevBtn.onclick = () => {
      const query = searchInput.value;
      if (query) Object.values(terminals).forEach(({ searchAddon }) => searchAddon.findPrevious(query));
    };

    // =========================================================================
    // 4. Multi-Terminal + Window Drag & Drop
    // =========================================================================
    let windowCounter = 1;

    document.getElementById('btn-add-term').onclick = () => {
      windowCounter++;
      const newCardId = 'card-' + windowCounter;
      const offset = (windowCounter - 1) * 35;

      const cardHtml = \`
        <div class="terminal-card" id="\${newCardId}" style="left: \${120 + offset}px; top: \${80 + offset}px; width: 800px; height: 480px; z-index: \${++highestZ};">
          <div class="card-header" id="\${newCardId}-header">
            <div class="window-dots">
              <div class="dot dot-red" title="Close" onclick="removeWindow('\${newCardId}')"></div>
              <div class="dot dot-yellow" title="Minimize" onclick="toggleMinimize('\${newCardId}')"></div>
              <div class="dot dot-green" title="Maximize" onclick="maximizeWindow('\${newCardId}')"></div>
            </div>
            <div class="card-title"><span>root@${name}:~# [\${windowCounter}]</span></div>
            <div class="card-tools">
              <span class="tool-icon" onclick="clearActiveTerminal('\${newCardId}')">🧹</span>
            </div>
          </div>
          <div class="terminal-body" id="term-container-\${windowCounter}"></div>
          <div class="resize-handle" onmousedown="initResize(event, '\${newCardId}')">⋰</div>
        </div>
      \`;

      world.insertAdjacentHTML('beforeend', cardHtml);
      createTerminalWindow(newCardId, document.getElementById('term-container-' + windowCounter));
    };

    function bringToFront(card) {
      card.style.zIndex = ++highestZ;
      document.querySelectorAll('.terminal-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    }

    function makeDraggable(card) {
      const header = card.querySelector('.card-header');
      let isDragging = false;
      let offX = 0, offY = 0;

      card.addEventListener('mousedown', () => bringToFront(card));

      header.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('dot') || e.target.classList.contains('tool-icon')) return;
        isDragging = true;
        bringToFront(card);
        offX = (e.clientX / scale) - card.offsetLeft;
        offY = (e.clientY / scale) - card.offsetTop;
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        card.style.left = ((e.clientX / scale) - offX) + 'px';
        card.style.top = ((e.clientY / scale) - offY) + 'px';
      });

      window.addEventListener('mouseup', () => { isDragging = false; });
    }

    // Resize Handler
    function initResize(e, cardId) {
      e.stopPropagation();
      e.preventDefault();
      const card = document.getElementById(cardId);
      const startW = card.offsetWidth;
      const startH = card.offsetHeight;
      const startMouseX = e.clientX;
      const startMouseY = e.clientY;

      function doResize(ev) {
        card.style.width = (startW + (ev.clientX - startMouseX) / scale) + 'px';
        card.style.height = (startH + (ev.clientY - startMouseY) / scale) + 'px';
        if (terminals[cardId]) terminals[cardId].fitAddon.fit();
      }

      function stopResize() {
        window.removeEventListener('mousemove', doResize);
        window.removeEventListener('mouseup', stopResize);
      }

      window.addEventListener('mousemove', doResize);
      window.addEventListener('mouseup', stopResize);
    }

    function removeWindow(cardId) {
      const card = document.getElementById(cardId);
      if (card) {
        card.remove();
        delete terminals[cardId];
      }
    }

    function toggleMinimize(cardId) {
      const card = document.getElementById(cardId);
      const body = card.querySelector('.terminal-body');
      if (body.style.display === 'none') {
        body.style.display = 'block';
        card.style.height = '480px';
        if (terminals[cardId]) terminals[cardId].fitAddon.fit();
      } else {
        body.style.display = 'none';
        card.style.height = '38px';
      }
    }

    function maximizeWindow(cardId) {
      const card = document.getElementById(cardId);
      card.style.left = '40px';
      card.style.top = '20px';
      card.style.width = (window.innerWidth - 80) + 'px';
      card.style.height = (window.innerHeight - 120) + 'px';
      if (terminals[cardId]) terminals[cardId].fitAddon.fit();
    }

    function clearActiveTerminal(cardId = 'card-1') {
      if (terminals[cardId]) terminals[cardId].term.clear();
    }

    window.addEventListener('resize', () => {
      Object.values(terminals).forEach(({ fitAddon }) => fitAddon.fit());
    });
  </script>
</body>
</html>`;
}
