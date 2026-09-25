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
    this.dockerBin = this.resolveBinary('docker', ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker']);
    this.lxcBin = this.resolveBinary('lxc', ['/snap/bin/lxc', '/usr/bin/lxc', '/usr/local/bin/lxc']);
    this.ensureHostTtyd();
  }

  resolveBinary(name, candidates) {
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    try {
      return this.run(`command -v ${name}`).trim();
    } catch {
      return name;
    }
  }

  run(command, options = {}) {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin' },
      ...options,
    });
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
        this.run('lxc version');
        return 'lxd';
      } catch {
        return 'docker';
      }
    }
  }

  isAvailable() {
    try {
      if (this.engine === 'docker') {
        this.run(`${this.dockerBin} info`);
        return true;
      } else {
        this.run(`${this.lxcBin} version`);
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

  // 1. Cloudflare Worker Web Terminal Bridge (Real Interactive PTY + Heartbeat)
  createWorkerBridge(name) {
    if (!config.proxyUrl) return null;
    const token = crypto.randomBytes(12).toString('hex');
    const wsUrl = config.proxyUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + `/tunnel/${name}?token=${token}`;
    const webUrl = config.proxyUrl.replace(/\/+$/, '') + `/term/${name}?token=${token}`;

    try {
      const WebSocket = require('ws');
      const ws = new WebSocket(wsUrl);

      // Clean up previous bridge instance if present
      if (this.workerBridges[name]) {
        try { this.workerBridges[name].ws.close(); } catch {}
        try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
        if (this.workerBridges[name].pingInterval) clearInterval(this.workerBridges[name].pingInterval);
        delete this.workerBridges[name];
      }

      ws.on('open', () => {
        console.log(`[Worker Bridge Active for ${name}]: ${webUrl}`);

        // Keepalive heartbeat ping every 15 seconds
        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.ping(); } catch {}
          }
        }, 15000);

        // Spawn interactive subshell inside container using script for full PTY
        const targetCmd = this.engine === 'docker'
          ? `${this.dockerBin} exec -it ${name} bash`
          : `${this.lxcBin} exec ${name} -- bash`;

        const proc = spawn('/usr/bin/script', ['-qefc', targetCmd, '/dev/null'], {
          env: {
            ...process.env,
            PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin',
            TERM: 'xterm-256color',
            LANG: 'C.UTF-8',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
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

        ws.on('close', () => {
          clearInterval(pingInterval);
          try { proc.kill('SIGKILL'); } catch {}
          delete this.workerBridges[name];
        });

        proc.on('close', () => {
          clearInterval(pingInterval);
          try { ws.close(); } catch {}
          delete this.workerBridges[name];
        });

        this.workerBridges[name] = { ws, proc, url: webUrl, token, pingInterval };
      });

      ws.on('error', (err) => {
        console.warn(`[Worker Bridge error for ${name}]:`, err.message);
      });

      return webUrl;
    } catch (e) {
      console.warn(`[Worker Bridge exception]:`, e.message);
      return null;
    }
  }

  // 2. Ngrok Tunnel Fallback
  async createNgrokTunnel(name, webPort) {
    const token = config.ngrokAuthToken || process.env.NGROK_AUTHTOKEN;
    if (!token) return null;
    try {
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
    if (config.proxyUrl) {
      try {
        const workerUrl = this.createWorkerBridge(name);
        if (workerUrl) return workerUrl;
      } catch {}
    }

    try {
      const ngrokUrl = await this.createNgrokTunnel(name, webPort);
      if (ngrokUrl) return ngrokUrl;
    } catch {}

    try {
      const localtunnel = require('localtunnel');
      const tunnel = await localtunnel({ port: webPort });
      if (tunnel && tunnel.url) {
        this.tunnels[name] = tunnel;
        return tunnel.url;
      }
    } catch (err) {
      console.warn(`[LocalTunnel warning for ${name}]:`, err.message);
    }

    return this.getWebTerminalUrl(webPort);
  }

  // Create Container with Security Quotas & Optional Template Setup
  async createContainer({ name, image, cpu, ram, templateKey = 'none' }) {
    const rootPassword = this.generatePassword();
    const targetImage = this.formatImage(image);
    const sshPort = this.getRandomPort(20000, 34000);
    const webPort = this.getRandomPort(34001, 49000);
    const hostIp = this.getHostPublicIP();
    const pidsLimit = config.pidsLimit || 250;

    this.ensureHostTtyd();

    if (this.engine === 'docker') {
      try {
        const memLimit = this.formatDockerMemory(ram);
        const cpuLimit = cpu || '1';

        // Launch container with strict security hardening & resource limits
        this.run(
          `${this.dockerBin} run -d --name ${name} --hostname ${name} ` +
          `--dns 8.8.8.8 --dns 1.1.1.1 -p ${sshPort}:22 ` +
          `--memory="${memLimit}" --memory-swap="${memLimit}" --cpus="${cpuLimit}" ` +
          `--pids-limit ${pidsLimit} --security-opt no-new-privileges:true ` +
          `${targetImage} sleep infinity`
        );

        // Set root password
        this.run(`${this.dockerBin} exec ${name} bash -c "echo 'root:${rootPassword}' | chpasswd"`);

        // Template installation script (if selected)
        const selectedTemplate = config.templates[templateKey];
        const templateScript = selectedTemplate && selectedTemplate.script ? selectedTemplate.script : '';

        // Base SSH & environment setup script
        const initScript = `
          apt-get update -y >/dev/null 2>&1
          apt-get install -y openssh-server curl sudo procps net-tools ca-certificates >/dev/null 2>&1 || true
          mkdir -p /var/run/sshd
          sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config 2>/dev/null || true
          sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config 2>/dev/null || true
          service ssh restart >/dev/null 2>&1 || /etc/init.d/ssh restart >/dev/null 2>&1 || true
          ${templateScript}
        `;

        // Run setup in background
        exec(`${this.dockerBin} exec ${name} bash -c "${initScript.replace(/\n/g, ' ')}"`);

        // Start Host-level ttyd attached directly to this container
        exec(
          `nohup ttyd -p ${webPort} -i 127.0.0.1 -c root:${rootPassword} -W ${this.dockerBin} exec -it ${name} bash > /tmp/ttyd_${name}.log 2>&1 &`
        );

        // Open Public Web Tunnel
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
          this.run(`${this.dockerBin} rm -f ${name}`);
        } catch {}
        throw new Error(`Failed to create Docker VPS: ${err.message}`);
      }
    } else {
      // LXD Engine fallback
      try {
        this.run(`${this.lxcBin} launch ${targetImage} ${name}`);
        if (cpu) this.run(`${this.lxcBin} config set ${name} limits.cpu ${cpu}`);
        if (ram) this.run(`${this.lxcBin} config set ${name} limits.memory ${ram}`);
        this.run(`${this.lxcBin} config set ${name} limits.processes ${pidsLimit}`);
        this.run(`${this.lxcBin} exec ${name} -- bash -c "echo 'root:${rootPassword}' | chpasswd"`);

        const selectedTemplate = config.templates[templateKey];
        if (selectedTemplate && selectedTemplate.script) {
          exec(`${this.lxcBin} exec ${name} -- bash -c "${selectedTemplate.script.replace(/\n/g, ' ')}"`);
        }

        const webTerminalUrl = this.createWorkerBridge(name) || this.getWebTerminalUrl(22);
        return { success: true, password: rootPassword, sshPort: 22, webPort: null, webTerminalUrl, hostIp };
      } catch (err) {
        try {
          this.run(`${this.lxcBin} delete -f ${name}`);
        } catch {}
        throw new Error(`Failed to create LXD VPS: ${err.message}`);
      }
    }
  }

  start(name) {
    if (this.engine === 'docker') {
      this.run(`${this.dockerBin} start ${name}`);
      // Re-establish worker bridge on start
      if (config.proxyUrl) {
        setTimeout(() => this.createWorkerBridge(name), 1000);
      }
    } else {
      this.run(`${this.lxcBin} start ${name}`);
      if (config.proxyUrl) {
        setTimeout(() => this.createWorkerBridge(name), 1000);
      }
    }
  }

  stop(name) {
    if (this.engine === 'docker') {
      this.run(`${this.dockerBin} stop ${name}`);
      exec(`pkill -f "ttyd.*${name}" 2>/dev/null || true`);
      if (this.workerBridges[name]) {
        if (this.workerBridges[name].pingInterval) clearInterval(this.workerBridges[name].pingInterval);
        try { this.workerBridges[name].ws.close(); } catch {}
        try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
        delete this.workerBridges[name];
      }
      if (this.ngrokListeners[name]) {
        try { this.ngrokListeners[name].close(); } catch {}
        delete this.ngrokListeners[name];
      }
    } else {
      this.run(`${this.lxcBin} stop ${name} --force`);
      if (this.workerBridges[name]) {
        if (this.workerBridges[name].pingInterval) clearInterval(this.workerBridges[name].pingInterval);
        try { this.workerBridges[name].ws.close(); } catch {}
        try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
        delete this.workerBridges[name];
      }
    }
  }

  restart(name) {
    this.stop(name);
    setTimeout(() => this.start(name), 1500);
  }

  delete(name) {
    if (this.engine === 'docker') {
      this.run(`${this.dockerBin} rm -f ${name}`);
      exec(`pkill -f "ttyd.*${name}" 2>/dev/null || true`);
      if (this.workerBridges[name]) {
        if (this.workerBridges[name].pingInterval) clearInterval(this.workerBridges[name].pingInterval);
        try { this.workerBridges[name].ws.close(); } catch {}
        try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
        delete this.workerBridges[name];
      }
      if (this.ngrokListeners[name]) {
        try { this.ngrokListeners[name].close(); } catch {}
        delete this.ngrokListeners[name];
      }
    } else {
      this.run(`${this.lxcBin} delete -f ${name}`);
      if (this.workerBridges[name]) {
        if (this.workerBridges[name].pingInterval) clearInterval(this.workerBridges[name].pingInterval);
        try { this.workerBridges[name].ws.close(); } catch {}
        try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
        delete this.workerBridges[name];
      }
    }
  }

  getInfo(name) {
    try {
      if (this.engine === 'docker') {
        const inspectOut = this.run(`${this.dockerBin} inspect ${name}`);
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
          hostIp,
        };
      } else {
        const output = this.run(`${this.lxcBin} list ${name} --format json`);
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
          hostIp: this.getHostPublicIP(),
        };
      }
    } catch {
      return null;
    }
  }

  // Backup / Snapshot
  createBackup(name) {
    const timestamp = Date.now();
    const tag = `backup-${name}-${timestamp}`;
    if (this.engine === 'docker') {
      this.run(`${this.dockerBin} commit ${name} ${tag}`);
      return { tag, timestamp };
    } else {
      this.run(`${this.lxcBin} snapshot ${name} ${tag}`);
      return { tag, timestamp };
    }
  }

  // Restore from Backup
  restoreBackup(name, tag) {
    if (this.engine === 'docker') {
      const inspectOut = this.run(`${this.dockerBin} inspect ${name}`);
      const data = JSON.parse(inspectOut)[0];
      const ports = data.HostConfig?.PortBindings || {};
      const sshPort = ports['22/tcp']?.[0]?.HostPort || this.getRandomPort(20000, 34000);
      
      this.run(`${this.dockerBin} rm -f ${name}`);
      this.run(`${this.dockerBin} run -d --name ${name} --hostname ${name} -p ${sshPort}:22 ${tag} sleep infinity`);
      return true;
    } else {
      this.run(`${this.lxcBin} restore ${name} ${tag}`);
      return true;
    }
  }

  // Expose / Forward Port
  exposePort(name, containerPort) {
    const hostPort = this.getRandomPort(30000, 45000);
    const hostIp = this.getHostPublicIP();

    if (this.engine === 'docker') {
      const inspectOut = this.run(`${this.dockerBin} inspect ${name}`);
      const data = JSON.parse(inspectOut)[0];
      const ip = data.NetworkSettings?.IPAddress;
      if (!ip) throw new Error('Container IP not available. Ensure container is running.');

      exec(
        `nohup socat TCP-LISTEN:${hostPort},fork,reuseaddr TCP:${ip}:${containerPort} > /tmp/socat_${name}_${hostPort}.log 2>&1 &`
      );

      return { hostPort, containerPort, hostIp, publicUrl: `http://${hostIp}:${hostPort}` };
    } else {
      const deviceName = `port-${containerPort}`;
      try {
        this.run(`${this.lxcBin} config device add ${name} ${deviceName} proxy listen=tcp:0.0.0.0:${hostPort} connect=tcp:127.0.0.1:${containerPort}`);
      } catch (e) {
        const info = this.getInfo(name);
        if (info && info.ipv4 && info.ipv4 !== 'N/A') {
          exec(`nohup socat TCP-LISTEN:${hostPort},fork,reuseaddr TCP:${info.ipv4}:${containerPort} > /dev/null 2>&1 &`);
        }
      }
      return { hostPort, containerPort, hostIp, publicUrl: `http://${hostIp}:${hostPort}` };
    }
  }

  async createWebTerminal(name) {
    const vps = db.getVPS(name);
    if (!vps) throw new Error('VPS not found in database.');

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
