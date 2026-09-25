/**
 * Cloudflare Worker for VPS Discord Bot:
 * 1. Discord Gateway & REST API Proxy (bypasses egress firewall)
 * 2. Secure In-Browser Web Terminal (xterm.js) + Realtime WebSocket Relay
 */

// Durable Object export (required by Cloudflare schema migration)
export class TerminalSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
}

// Active sessions map
const sessions = new Map();

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // =======================================================================
      // 1. Web Terminal UI & WebSocket Bridge
      // =======================================================================
      if (url.pathname.startsWith('/term/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        const name = parts[1];
        const isWs = parts[2] === 'ws' || request.headers.get('Upgrade') === 'websocket';
        const token = url.searchParams.get('token');

        // Serve HTML Terminal Interface
        if (!isWs) {
          return new Response(getTerminalHTML(name, token), {
            headers: { 'Content-Type': 'text/html;charset=utf-8' },
          });
        }

        // Handle Browser WebSocket Connection
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();

        let session = sessions.get(name);
        if (!session) {
          session = { name, token, agentWs: null, browserWs: null };
          sessions.set(name, session);
        }

        session.browserWs = server;

        server.addEventListener('message', (event) => {
          if (session.agentWs && session.agentWs.readyState === WebSocket.OPEN) {
            session.agentWs.send(event.data);
          }
        });

        server.addEventListener('close', () => {
          if (session.browserWs === server) {
            session.browserWs = null;
          }
        });

        if (session.agentWs && session.agentWs.readyState === WebSocket.OPEN) {
          server.send('\r\n\x1b[32m[Connected to Container Web Terminal]\x1b[0m\r\n\r\n');
        } else {
          server.send('\r\n\x1b[33m[Waiting for container shell connection...]\x1b[0m\r\n');
        }

        return new Response(null, { status: 101, webSocket: client });
      }

      // =======================================================================
      // 2. Daytona Host Agent Tunnel: /tunnel/:containerName?token=XYZ
      // =======================================================================
      if (url.pathname.startsWith('/tunnel/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        const name = parts[1];
        const token = url.searchParams.get('token');

        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('Expected WebSocket upgrade', { status: 426 });
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();

        let session = sessions.get(name);
        if (!session) {
          session = { name, token, agentWs: null, browserWs: null };
          sessions.set(name, session);
        }

        session.agentWs = server;
        session.token = token;

        server.addEventListener('message', (event) => {
          if (session.browserWs && session.browserWs.readyState === WebSocket.OPEN) {
            session.browserWs.send(event.data);
          }
        });

        server.addEventListener('close', () => {
          if (session.browserWs && session.browserWs.readyState === WebSocket.OPEN) {
            session.browserWs.send('\r\n\x1b[33m[Host disconnected container session]\x1b[0m\r\n');
          }
          if (session.agentWs === server) {
            session.agentWs = null;
          }
        });

        if (session.browserWs && session.browserWs.readyState === WebSocket.OPEN) {
          session.browserWs.send('\r\n\x1b[32m[Container Terminal Shell Ready]\x1b[0m\r\n\r\n');
        }

        return new Response(null, { status: 101, webSocket: client });
      }

      // =======================================================================
      // 3. Discord Gateway & REST API Proxy
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

    document.getElementById('terminal-container').addEventListener('click', () => {
      term.focus();
    });

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
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('\\r');
      }, 300);
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
