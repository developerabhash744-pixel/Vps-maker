const { execSync, exec, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');
const db = require('./database');

class ContainerManager {
  constructor() {
    this.engine = this.detectEngine();
    this.cachedIP = null;
    this.tunnels = {};
    this.ngrokListeners = {};
    this.workerBridges = {};
    this.ensureHostTtyd();
  }

  run(command, options = {}) {
    return execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
  }

  ensureHostTtyd() {
    try {
      this.run('command -v ttyd');
    } catch {
      try {
        const arch = this.run('uname -m').trim();
        this.run(
          `curl -fsSLo /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${arch}" && chmod +x /usr/local/bin/ttyd`
        );
      } catch (e) {
        console.warn('[Host ttyd install note]:', e.message);
      }
    }
  }

  detectEngine() {
    try {
      this.run('docker --version');
      return 'docker';
    } catch {
      try {
        const lxcBin = fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc';
        this.run(`${lxcBin} version`);
        return 'lxd';
      } catch {
        return 'docker';
      }
    }
  }

  isAvailable() {
    try {
      if (this.engine === 'docker') {
        this.run('docker info');
        return true;
      } else {
        const lxcBin = fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc';
        this.run(`${lxcBin} version`);
        return true;
      }
    } catch {
      return false;
    }
  }

  getHostPublicIP() {
    if (config.serverIp) return config.serverIp;
    try {
      if (this.cachedIP) return this.cachedIP;
      const ip = this.run(
        'curl -s --connect-timeout 4 https://api.ipify.org || curl -s --connect-timeout 4 https://icanhazip.com || curl -s --connect-timeout 4 https://ifconfig.me'
      ).trim();
      if (ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        this.cachedIP = ip;
        return ip;
      }
    } catch {}
    return '127.0.0.1';
  }

  generatePassword(length = 14) {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
      password += charset[bytes[i] % charset.length];
    }
    return password;
  }

  getRandomPort(min = 20000, max = 34000) {
    return Math.floor(Math.random() * (max - min) + min);
  }

  formatDockerMemory(ram) {
    if (!ram) return '1g';
    return ram.toLowerCase().replace('gib', 'g').replace('mib', 'm');
  }

  formatImage(image) {
    if (this.engine === 'docker') {
      if (image === 'ubuntu:24.04' || image === 'ubuntu:22.04') return image;
      if (image.includes('debian')) return 'debian:12';
      return image.replace('images:', '');
    }
    return image;
  }

  getWebTerminalUrl(webPort) {
    if (!webPort) return null;
    const hostIp = this.getHostPublicIP();
    return `http://${hostIp}:${webPort}`;
  }

  createWorkerBridge(name) {
    if (!config.proxyUrl) return null;
    const vps = db.getVPS(name);
    const token = (vps && vps.webToken) || crypto.randomBytes(12).toString('hex');
    if (vps && !vps.webToken) {
      db.setVPS(name, { ...vps, webToken: token });
    }

    const wsUrl = config.proxyUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + `/tunnel/${name}?token=${token}`;
    const webUrl = config.proxyUrl.replace(/\/+$/, '') + `/term/${name}?token=${token}`;

    if (this.workerBridges[name] && this.workerBridges[name].ws?.readyState === 1) {
      return webUrl;
    }

    try {
      const WebSocket = require('ws');
      const ws = new WebSocket(wsUrl);

      let pingTimer = null;

      ws.on('open', () => {
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.ping(); } catch {}
          }
        }, 15000);

        const dockerBin = fs.existsSync('/usr/bin/docker')
          ? '/usr/bin/docker'
          : (fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker');
        const lxcBin = fs.existsSync('/snap/bin/lxc')
          ? '/snap/bin/lxc'
          : (fs.existsSync('/usr/bin/lxc') ? '/usr/bin/lxc' : 'lxc');

        const innerCmd = this.engine === 'docker'
          ? `${dockerBin} exec -it ${name} bash`
          : `${lxcBin} exec ${name} -- bash`;

        const fullPath = (process.env.PATH || '') + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

        const proc = spawn('script', ['-qefc', innerCmd, '/dev/null'], {
          env: {
            ...process.env,
            PATH: fullPath,
            TERM: 'xterm-256color',
            COLUMNS: '120',
            LINES: '30',
          },
        });

        proc.stdout.on('data', (d) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(d);
        });
        proc.stderr.on('data', (d) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(d);
        });

        ws.on('message', (msg) => {
          try {
            proc.stdin.write(msg);
          } catch {}
        });

        ws.on('close', (code, reason) => {
          if (pingTimer) clearInterval(pingTimer);
          try { proc.kill('SIGKILL'); } catch {}
          delete this.workerBridges[name];
        });

        proc.on('close', (code) => {
          if (pingTimer) clearInterval(pingTimer);
          try { ws.close(); } catch {}
          delete this.workerBridges[name];
        });

        this.workerBridges[name] = { ws, proc, url: webUrl, token };
        console.log(`[Worker Bridge Connected for ${name}]: ${webUrl}`);
      });

      ws.on('error', (err) => {
        if (pingTimer) clearInterval(pingTimer);
        console.warn(`[Worker Bridge error for ${name}]:`, err.message);
      });

      return webUrl;
    } catch (e) {
      console.warn(`[Worker Bridge exception]:`, e.message);
      return null;
    }
  }

  // 2. Ngrok Ingress (Native official SDK)
  async createNgrokTunnel(name, webPort) {
    const token = config.ngrokAuthToken || process.env.NGROK_AUTHTOKEN;
    if (!token) return null;
    try {
      console.log(`[Ngrok] Opening tunnel for ${name} on port ${webPort}...`);
      const ngrok = require('@ngrok/ngrok');
      const listener = await ngrok.forward({
        addr: webPort,
        authtoken: token,
      });
      if (listener && listener.url()) {
        const url = listener.url();
        console.log(`[Ngrok Active for ${name}]: ${url}`);
        this.ngrokListeners[name] = listener;
        return url;
      }
    } catch (err) {
      console.warn(`[Ngrok warning for ${name}]:`, err.message);
    }
    return null;
  }

  // 3. Public Tunnel Manager
  async createPublicTunnel(name, webPort) {
    // Priority 1: Cloudflare Worker Bridge (Firewall-Proof)
    try {
      const workerUrl = this.createWorkerBridge(name);
      if (workerUrl) return workerUrl;
    } catch {}

    // Priority 2: Ngrok
    try {
      const ngrokUrl = await this.createNgrokTunnel(name, webPort);
      if (ngrokUrl) return ngrokUrl;
    } catch {}

    // Priority 3: LocalTunnel npm
    try {
      console.log(`[Public Tunnel] Opening LocalTunnel for ${name} on port ${webPort}...`);
      const localtunnel = require('localtunnel');
      const tunnel = await localtunnel({ port: webPort });
      if (tunnel && tunnel.url) {
        console.log(`[LocalTunnel Active for ${name}]: ${tunnel.url}`);
        this.tunnels[name] = tunnel;
        return tunnel.url;
      }
    } catch (err) {
      console.warn(`[LocalTunnel warning for ${name}]:`, err.message);
    }

    // Fallback: Host Direct IP
    return this.getWebTerminalUrl(webPort);
  }

  async createContainer({ name, image, cpu, ram }) {
    const rootPassword = this.generatePassword();
    const targetImage = this.formatImage(image);
    const sshPort = this.getRandomPort(20000, 34000);
    const webPort = this.getRandomPort(34001, 49000);
    const hostIp = this.getHostPublicIP();

    this.ensureHostTtyd();

    if (this.engine === 'docker') {
      try {
        const memLimit = this.formatDockerMemory(ram);
        const cpuLimit = cpu || '1';

        // 1. Launch container with exposed SSH port
        this.run(
          `docker run -d --name ${name} --hostname ${name} --dns 8.8.8.8 --dns 1.1.1.1 -p ${sshPort}:22 --memory="${memLimit}" --cpus="${cpuLimit}" ${targetImage} sleep infinity`
        );

        // 2. Set root password
        this.run(`docker exec ${name} bash -c "echo 'root:${rootPassword}' | chpasswd"`);

        // 3. Background SSH server setup
        const initScript = `
          apt-get update -y >/dev/null 2>&1
          apt-get install -y openssh-server curl sudo procps net-tools ca-certificates >/dev/null 2>&1 || true
          mkdir -p /var/run/sshd
          sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config 2>/dev/null || true
          sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config 2>/dev/null || true
          service ssh restart >/dev/null 2>&1 || /etc/init.d/ssh restart >/dev/null 2>&1 || true
        `;
        exec(`docker exec ${name} bash -c "${initScript.replace(/\n/g, ' ')}"`);

        // 4. Start Host-level ttyd attached directly to this container's interactive shell
        exec(
          `nohup ttyd -p ${webPort} -i 127.0.0.1 -c root:${rootPassword} -W docker exec -it ${name} bash > /tmp/ttyd_${name}.log 2>&1 &`
        );

        // 5. Open Public Web Tunnel (Worker Bridge / Ngrok / LocalTunnel)
        let webTerminalUrl = await this.createPublicTunnel(name, webPort);
        if (!webTerminalUrl) {
          webTerminalUrl = this.getWebTerminalUrl(webPort);
        }

        return {
          success: true,
          password: rootPassword,
          sshPort,
          webPort,
          webTerminalUrl,
          hostIp,
        };
      } catch (err) {
        try {
          this.run(`docker rm -f ${name}`);
        } catch {}
        throw new Error(`Failed to create Docker VPS: ${err.message}`);
      }
    } else {
      // LXD Engine fallback
      const lxcBin = fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc';
      try {
        this.run(`${lxcBin} launch ${targetImage} ${name}`);
        if (cpu) this.run(`${lxcBin} config set ${name} limits.cpu ${cpu}`);
        if (ram) this.run(`${lxcBin} config set ${name} limits.memory ${ram}`);
        this.run(`${lxcBin} exec ${name} -- bash -c "echo 'root:${rootPassword}' | chpasswd"`);
        const webTerminalUrl = this.createWorkerBridge(name) || this.getWebTerminalUrl(22);
        return { success: true, password: rootPassword, sshPort: 22, webPort: null, webTerminalUrl, hostIp };
      } catch (err) {
        try {
          this.run(`${lxcBin} delete -f ${name}`);
        } catch {}
        throw new Error(`Failed to create LXD VPS: ${err.message}`);
      }
    }
  }

  start(name) {
    if (this.engine === 'docker') {
      this.run(`docker start ${name}`);
    } else {
      const lxcBin = fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc';
      this.run(`${lxcBin} start ${name}`);
    }
  }

  stop(name) {
    if (this.engine === 'docker') {
      this.run(`docker stop ${name}`);
      exec(`pkill -f "ttyd.*${name}" 2>/dev/null || true`);
      if (this.workerBridges[name]) {
        try { this.workerBridges[name].ws.close(); } catch {}
        try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
        delete this.workerBridges[name];
      }
      if (this.ngrokListeners[name]) {
        try { this.ngrokListeners[name].close(); } catch {}
        delete this.ngrokListeners[name];
      }
    } else {
      const lxcBin = fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc';
      this.run(`${lxcBin} stop ${name} --force`);
    }
  }

  restart(name) {
    if (this.engine === 'docker') {
      this.run(`docker restart ${name}`);
    } else {
      const lxcBin = fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc';
      this.run(`${lxcBin} restart ${name}`);
    }
  }

  delete(name) {
    if (this.engine === 'docker') {
      this.run(`docker rm -f ${name}`);
      exec(`pkill -f "ttyd.*${name}" 2>/dev/null || true`);
      exec(`pkill -f "cloudflared.*${name}" 2>/dev/null || true`);
      if (this.workerBridges[name]) {
        try { this.workerBridges[name].ws.close(); } catch {}
        try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
        delete this.workerBridges[name];
      }
      if (this.ngrokListeners[name]) {
        try { this.ngrokListeners[name].close(); } catch {}
        delete this.ngrokListeners[name];
      }
    } else {
      const lxcBin = fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc';
      this.run(`${lxcBin} delete -f ${name}`);
    }
  }

  getInfo(name) {
    try {
      if (this.engine === 'docker') {
        const inspectOut = this.run(`docker inspect ${name}`);
        const data = JSON.parse(inspectOut)[0];
        if (!data) return null;

        const isRunning = data.State?.Running;
        const ip = data.NetworkSettings?.IPAddress || '127.0.0.1';
        const sshPort = data.HostConfig?.PortBindings?.['22/tcp']?.[0]?.HostPort || 'N/A';
        const hostIp = this.getHostPublicIP();

        return {
          name,
          status: isRunning ? 'Running' : 'Stopped',
          ipv4: ip,
          sshPort,
          memoryUsage: isRunning ? 'Active' : 'Offline',
          engine: 'Docker',
        };
      } else {
        const lxcBin = fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc';
        const output = this.run(`${lxcBin} list ${name} --format json`);
        const list = JSON.parse(output);
        if (!list || list.length === 0) return null;

        const info = list[0];
        const ipv4 = (info.state?.network?.eth0?.addresses || [])
          .filter((a) => a.family === 'inet')
          .map((a) => a.address)[0] || 'N/A';

        return {
          name: info.name,
          status: info.status,
          ipv4,
          sshPort: '22',
          memoryUsage: info.state?.memory?.usage ? `${Math.round(info.state.memory.usage / 1024 / 1024)} MB` : 'N/A',
          engine: 'LXD',
        };
      }
    } catch {
      return null;
    }
  }

  async createWebTerminal(name) {
    const vps = db.getVPS(name);
    if (!vps) throw new Error('VPS not found in database.');

    // 1. Worker bridge
    if (config.proxyUrl) {
      const workerUrl = this.createWorkerBridge(name);
      if (workerUrl) {
        db.setVPS(name, { ...vps, webTerminalUrl: workerUrl });
        return workerUrl;
      }
    }

    if (this.ngrokListeners && this.ngrokListeners[name] && this.ngrokListeners[name].url()) {
      return this.ngrokListeners[name].url();
    }
    if (this.tunnels && this.tunnels[name] && this.tunnels[name].url) {
      return this.tunnels[name].url;
    }
    if (vps.webPort) {
      const url = await this.createPublicTunnel(name, vps.webPort);
      if (url) {
        db.setVPS(name, { ...vps, webTerminalUrl: url });
        return url;
      }
      return this.getWebTerminalUrl(vps.webPort);
    }
    if (vps.webTerminalUrl) {
      return vps.webTerminalUrl;
    }
    throw new Error('Web terminal is not configured for this container.');
  }
}

module.exports = new ContainerManager();
