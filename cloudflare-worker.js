/**
 * Cloudflare Worker for VPS Discord Bot:
 * 1. Discord Gateway & REST API Proxy (bypasses egress firewall)
 * 2. Globally Synchronized In-Browser Web Terminal (xterm.js) via Durable Object
 */

import { DurableObject } from 'cloudflare:workers';

// =============================================================================
// Durable Object: Global Single Point of Presence per Container Session
// =============================================================================
export class TerminalSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.token = null;
    this.agentWs = null;
    this.browserWs = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    // 1. Daytona Host Agent Tunnel: /tunnel/:containerName?token=XYZ
    if (url.pathname.startsWith('/tunnel')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      this.token = token;
      this.agentWs = server;

      server.addEventListener('message', (event) => {
        if (this.browserWs && this.browserWs.readyState === WebSocket.OPEN) {
          this.browserWs.send(event.data);
        }
      });

      server.addEventListener('close', () => {
        if (this.browserWs) {
          this.browserWs.send('\r\n\x1b[33m[Host disconnected container session]\x1b[0m\r\n');
          this.browserWs.close();
        }
        this.agentWs = null;
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Web Terminal UI Route: /term/:containerName?token=XYZ
    if (url.pathname.startsWith('/term')) {
      const isWs = url.pathname.endsWith('/ws') || request.headers.get('Upgrade') === 'websocket';
      const parts = url.pathname.split('/').filter(Boolean);
      const name = parts[1] || 'vps';

      // Serve HTML Web Terminal UI
      if (!isWs) {
        return new Response(getTerminalHTML(name, token), {
          headers: { 'Content-Type': 'text/html;charset=utf-8' },
        });
      }

      // Handle Browser WebSocket Connection
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      if (!this.agentWs || (this.token && this.token !== token)) {
        server.send('\r\n\x1b[31m[Error]: Terminal session not active or invalid token.\x1b[0m\r\n');
        setTimeout(() => server.close(1008, 'Session not found'), 1000);
        return new Response(null, { status: 101, webSocket: client });
      }

      this.browserWs = server;

      server.addEventListener('message', (event) => {
        if (this.agentWs && this.agentWs.readyState === WebSocket.OPEN) {
          this.agentWs.send(event.data);
        }
      });

      server.addEventListener('close', () => {
        this.browserWs = null;
      });

      server.send('\r\n\x1b[32m[Connected to Container Web Terminal]\x1b[0m\r\n\r\n');
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }
}

// Fallback in-memory map if Durable Objects are not bound
const fallbackSessions = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // =========================================================================
    // 1. Web Terminal & Tunnel Routes
    // =========================================================================
    if (url.pathname.startsWith('/term/') || url.pathname.startsWith('/tunnel/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const name = parts[1];

      // Route through Durable Object for global session synchronization
      if (env.TERMINAL_SESSION) {
        const id = env.TERMINAL_SESSION.idFromName(name);
        const stub = env.TERMINAL_SESSION.get(id);
        return stub.fetch(request);
      }

      // Fallback in-memory handler
      if (url.pathname.startsWith('/term/')) {
        const isWs = parts[2] === 'ws' || request.headers.get('Upgrade') === 'websocket';
        const token = url.searchParams.get('token');

        if (!isWs) {
          return new Response(getTerminalHTML(name, token), {
            headers: { 'Content-Type': 'text/html;charset=utf-8' },
          });
        }

        if (request.headers.get('Upgrade') === 'websocket') {
          const pair = new WebSocketPair();
          const [client, server] = Object.values(pair);
          server.accept();

          const session = fallbackSessions.get(name);
          if (!session || (session.token && session.token !== token)) {
            server.send('\r\n\x1b[31m[Error]: Terminal session not active or invalid token.\x1b[0m\r\n');
            setTimeout(() => server.close(1008, 'Session not found'), 1000);
            return new Response(null, { status: 101, webSocket: client });
          }

          session.browserWs = server;
          server.addEventListener('message', (e) => session.agentWs?.send(e.data));
          server.addEventListener('close', () => { session.browserWs = null; });
          server.send('\r\n\x1b[32m[Connected to Container Web Terminal]\x1b[0m\r\n\r\n');
          return new Response(null, { status: 101, webSocket: client });
        }
      }

      if (url.pathname.startsWith('/tunnel/')) {
        const token = url.searchParams.get('token');
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('Expected WebSocket upgrade', { status: 426 });
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        const session = { name, token, agentWs: server, browserWs: null };
        fallbackSessions.set(name, session);
        server.addEventListener('message', (e) => session.browserWs?.send(e.data));
        server.addEventListener('close', () => {
          session.browserWs?.close();
          fallbackSessions.delete(name);
        });
        return new Response(null, { status: 101, webSocket: client });
      }
    }

    // =========================================================================
    // 2. Discord Gateway & REST API Proxy
    // =========================================================================
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
  },
};

function getTerminalHTML(name, token) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VPS Terminal: ${name}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f111a; font-family: 'Segoe UI', monospace; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    header { background: #1a1c29; color: #fff; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2d3148; }
    .title { font-weight: bold; font-size: 16px; display: flex; align-items: center; gap: 8px; }
    .badge { background: #5865F2; padding: 3px 8px; border-radius: 4px; font-size: 12px; }
    .status { font-size: 13px; color: #00FF88; display: flex; align-items: center; gap: 6px; }
    .status-dot { width: 8px; height: 8px; background: #00FF88; border-radius: 50%; box-shadow: 0 0 8px #00FF88; }
    #terminal-container { flex: 1; padding: 10px; }
    .xterm { height: 100%; }
  </style>
</head>
<body>
  <header>
    <div class="title">
      <span>🚀 Container Web Terminal</span>
      <span class="badge">${name}</span>
    </div>
    <div class="status" id="status-text">
      <div class="status-dot" id="status-dot"></div>
      <span id="status-msg">Connecting...</span>
    </div>
  </header>
  <div id="terminal-container"></div>
  <script>
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#0f111a',
        foreground: '#e6edf3',
        cursor: '#5865F2',
        selectionBackground: 'rgba(88, 101, 242, 0.3)',
      }
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    fitAddon.fit();

    window.addEventListener('resize', () => fitAddon.fit());

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + location.host + '/term/${encodeURIComponent(name)}/ws?token=${encodeURIComponent(token || '')}';
    const ws = new WebSocket(wsUrl);

    const statusMsg = document.getElementById('status-msg');
    const statusDot = document.getElementById('status-dot');

    ws.onopen = () => {
      statusMsg.innerText = 'Connected';
      statusMsg.style.color = '#00FF88';
      statusDot.style.background = '#00FF88';
      statusDot.style.boxShadow = '0 0 8px #00FF88';
      term.focus();
    };

    ws.onmessage = (e) => {
      term.write(e.data);
    };

    ws.onclose = () => {
      statusMsg.innerText = 'Disconnected';
      statusMsg.style.color = '#FF4444';
      statusDot.style.background = '#FF4444';
      statusDot.style.boxShadow = 'none';
      term.write('\\r\\n\\x1b[31m[Session Closed]\\x1b[0m\\r\\n');
    };

    ws.onerror = () => {
      statusMsg.innerText = 'Connection Error';
      statusMsg.style.color = '#FF4444';
      statusDot.style.background = '#FF4444';
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  </script>
</body>
</html>`;
}
