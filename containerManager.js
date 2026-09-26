const { execSync, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const config = require('./config');
const db = require('./database');

class ContainerManager {
  constructor() {
    this.engine = this.detectEngine();
    this.cachedIP = null;
    this.ngrokListeners = {};
    this.workerBridges = {};
    this.tunnels = {};
    this.dockerBin = this.resolveBinary('docker', ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker']);
    this.lxcBin = this.resolveBinary('lxc', ['/snap/bin/lxc', '/usr/bin/lxc', '/usr/local/bin/lxc']);
    this.ensureHostTtyd();
    this.ensureHostSshx();
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

  ensureHostSshx() {
    try {
      this.run('command -v sshx');
    } catch {
      try {
        this.run('curl -sSf https://sshx.io/get | sh -s -- -y 2>/dev/null || curl -sSf https://sshx.io/get | bash 2>/dev/null || true');
      } catch (e) {
        console.warn('[Host sshx install note]:', e.message);
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
    if (this.cachedIP) return this.cachedIP;

    try {
      const ip = this.run(
        'curl -s4 --connect-timeout 3 https://api.ipify.org || curl -s4 --connect-timeout 3 https://icanhazip.com || curl -s4 --connect-timeout 3 https://checkip.amazonaws.com || curl -s4 --connect-timeout 3 https://ifconfig.me'
      ).trim();
      if (ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        this.cachedIP = ip;
        return ip;
      }
    } catch {}

    try {
      const ifaces = os.networkInterfaces();
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name] || []) {
          if (iface.family === 'IPv4' && !iface.internal && iface.address !== '127.0.0.1') {
            this.cachedIP = iface.address;
            return iface.address;
          }
        }
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

  makeProgressBar(percent, length = 10) {
    const filled = Math.min(length, Math.max(0, Math.round((percent / 100) * length)));
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  // 1. Cloudflare Worker Web Terminal Bridge (Direct WebSocket PTY)
  createWorkerBridge(name) {
    if (!config.proxyUrl) return null;
    const token = crypto.randomBytes(12).toString('hex');
    const wsUrl = config.proxyUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + `/tunnel/${name}?token=${token}`;
    const webUrl = config.proxyUrl.replace(/\/+$/, '') + `/term/${name}?token=${token}`;

    try {
      const WebSocket = require('ws');
      const ws = new WebSocket(wsUrl);

      if (this.workerBridges[name]) {
        try { this.workerBridges[name].ws.close(); } catch {}
        try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
        if (this.workerBridges[name].pingInterval) clearInterval(this.workerBridges[name].pingInterval);
        delete this.workerBridges[name];
      }

      const { spawn } = require('child_process');
      const proc = this.engine === 'docker'
        ? spawn(this.dockerBin, ['exec', '-i', name, 'bash'])
        : spawn(this.lxcBin, ['exec', name, '--', 'bash']);

      ws.on('open', () => {
        console.log(`[Worker Bridge Active for ${name}]: ${webUrl}`);

        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.ping(); } catch {}
          }
        }, 15000);

        proc.stdout.on('data', (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        });

        proc.stderr.on('data', (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
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

  // 2. Ngrok Tunnel Manager (TCP for SSH, HTTP for Web Terminal)
  async createNgrokTunnel(name, port, proto = 'http') {
    const token = config.ngrokAuthToken || process.env.NGROK_AUTHTOKEN;
    if (!token) return null;
    try {
      const ngrok = require('@ngrok/ngrok');
      const options = { addr: port, authtoken: token };
      if (proto === 'tcp') options.proto = 'tcp';
      const listener = await ngrok.forward(options);
      if (listener && listener.url()) {
        const rawUrl = listener.url();
        this.ngrokListeners[`${name}_${proto}`] = listener;
        if (proto === 'tcp') {
          const clean = rawUrl.replace(/^tcp:\/\//, '');
          const [host, p] = clean.split(':');
          const sshCmd = `ssh root@${host} -p ${p}`;
          console.log(`[Ngrok TCP SSH Active for ${name}]:`, sshCmd);
          return { command: sshCmd, host, port: p, url: rawUrl };
        } else {
          console.log(`[Ngrok HTTP Tunnel Active for ${name}]:`, rawUrl);
          return rawUrl;
        }
      }
    } catch (e) {
      console.warn(`[Ngrok ${proto} tunnel error for ${name}]: ${e.message}`);
      if (e.cause) console.warn(`  ↳ Cause: ${e.cause.message || e.cause}`);
    }
    return null;
  }

  // 3. Pinggy Tunnel Manager (TCP for SSH, HTTP for Web Terminal)
  createPinggyTunnel(name, port, proto = 'tcp') {
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      const token = process.env.PINGGY_TOKEN || '';
      const prefix = token ? `${token}+` : '';
      const targetHost = proto === 'tcp' ? `${prefix}tcp+json@a.pinggy.io` : `${prefix}json@a.pinggy.io`;
      
      const args = [
        '-p', '443',
        '-R', `0:localhost:${port}`,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ConnectTimeout=5',
        targetHost
      ];

      let resolved = false;
      let child;
      try {
        child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        console.warn(`[Pinggy ${proto} spawn error for ${name}]:`, err.message);
        return resolve(null);
      }

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, 7000);

      const handleData = (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          
          // 1. Try parsing JSON output from Pinggy
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.url && !resolved) {
              resolved = true;
              clearTimeout(timer);
              if (proto === 'tcp') {
                const host = parsed.host || parsed.url.replace(/^tcp:\/\//, '').split(':')[0] || 'a.pinggy.io';
                const p = parsed.port || parsed.url.split(':').pop();
                const sshCmd = `ssh root@${host} -p ${p}`;
                console.log(`[Pinggy TCP SSH Active for ${name}]:`, sshCmd);
                this.tunnels[`${name}_pinggy_tcp`] = child;
                return resolve({ command: sshCmd, host, port: p });
              } else {
                console.log(`[Pinggy HTTP Tunnel Active for ${name}]:`, parsed.url);
                this.tunnels[`${name}_pinggy_http`] = child;
                return resolve(parsed.url);
              }
            }
          } catch {}

          // 2. Fallback to Regex matching
          if (proto === 'tcp') {
            const match = trimmed.match(/tcp:\/\/([^:\s]+):(\d+)/i) || trimmed.match(/ssh\s+-p\s+(\d+)\s+([^\s]+)/i);
            if (match && !resolved) {
              resolved = true;
              clearTimeout(timer);
              const host = match[1].includes('pinggy') ? match[1] : (match[2] || 'a.pinggy.io');
              const p = match[2] && !match[1].includes('pinggy') ? match[1] : match[2];
              const sshCmd = `ssh root@${host} -p ${p}`;
              console.log(`[Pinggy TCP SSH Active for ${name}]:`, sshCmd);
              this.tunnels[`${name}_pinggy_tcp`] = child;
              return resolve({ command: sshCmd, host, port: p });
            }
          } else {
            const match = trimmed.match(/https?:\/\/[a-z0-9\-\.]+\.a?\.?pinggy\.(link|io)/i);
            if (match && !resolved) {
              resolved = true;
              clearTimeout(timer);
              console.log(`[Pinggy HTTP Tunnel Active for ${name}]:`, match[0]);
              this.tunnels[`${name}_pinggy_http`] = child;
              return resolve(match[0]);
            }
          }
        }
      };

      child.stdout.on('data', handleData);
      child.stderr.on('data', handleData);
      child.on('error', (err) => {
        console.warn(`[Pinggy ${proto} error for ${name}]:`, err.message);
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
      child.on('exit', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
    });
  }

  // 4. LocalTunnel HTTP Manager
  async createLocalTunnel(name, port) {
    try {
      const localtunnel = require('localtunnel');
      const lt = await localtunnel({ port });
      if (lt && lt.url) {
        this.tunnels[`${name}_lt`] = lt;
        lt.on('error', () => {});
        return lt.url;
      }
    } catch {}
    return null;
  }

  // 5. sshx Cloud Collaborative Web Terminal Manager (Zero Config, 100% Global Access)
  async createSshxTerminal(name) {
    this.ensureHostSshx();
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      const shellCmd = this.engine === 'docker'
        ? `${this.dockerBin} exec -it ${name} bash`
        : `${this.lxcBin} exec ${name} -- bash`;

      if (this.tunnels[`${name}_sshx`]) {
        try { this.tunnels[`${name}_sshx`].kill(); } catch {}
        delete this.tunnels[`${name}_sshx`];
      }

      let child;
      try {
        child = spawn('sshx', ['-q', '--name', name, '--shell', shellCmd], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        console.warn(`[sshx spawn error for ${name}]:`, err.message);
        return resolve(null);
      }

      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, 7000);

      const handleData = (data) => {
        const text = data.toString();
        const match = text.match(/https:\/\/sshx\.io\/s\/[a-zA-Z0-9#_\-]+/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timer);
          const url = match[0].trim();
          console.log(`[sshx Web Terminal Active for ${name}]: ${url}`);
          this.tunnels[`${name}_sshx`] = child;
          resolve(url);
        }
      };

      child.stdout.on('data', handleData);
      child.stderr.on('data', handleData);
      child.on('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
      child.on('exit', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
    });
  }

  async createPublicTunnel(name, webPort) {
    // 1. Try sshx Cloud Web Terminal (Highest Reliability, Zero Port/Firewall Config, Works Everywhere)
    try {
      const sshxUrl = await this.createSshxTerminal(name);
      if (sshxUrl) return sshxUrl;
    } catch {}

    // 2. Try Cloudflare Worker Bridge
    if (config.proxyUrl) {
      try {
        const workerUrl = this.createWorkerBridge(name);
        if (workerUrl) return workerUrl;
      } catch {}
    }

    // 3. Try Ngrok HTTP
    if (config.ngrokAuthToken || process.env.NGROK_AUTHTOKEN) {
      try {
        const ngrokUrl = await this.createNgrokTunnel(name, webPort, 'http');
        if (ngrokUrl) return ngrokUrl;
      } catch {}
    }

    // 4. Try Pinggy HTTP
    try {
      const pinggyUrl = await this.createPinggyTunnel(name, webPort, 'http');
      if (pinggyUrl) return pinggyUrl;
    } catch {}

    // 5. Try LocalTunnel
    try {
      const ltUrl = await this.createLocalTunnel(name, webPort);
      if (ltUrl) return ltUrl;
    } catch {}

    return this.getWebTerminalUrl(webPort);
  }

  async createPublicSsh(name, sshPort) {
    // 1. Try Ngrok TCP
    if (config.ngrokAuthToken || process.env.NGROK_AUTHTOKEN) {
      try {
        const ngrokSsh = await this.createNgrokTunnel(name, sshPort, 'tcp');
        if (ngrokSsh && ngrokSsh.command) return ngrokSsh.command;
      } catch {}
    }

    // 2. Try Pinggy TCP
    try {
      const pinggySsh = await this.createPinggyTunnel(name, sshPort, 'tcp');
      if (pinggySsh && pinggySsh.command) return pinggySsh.command;
    } catch {}

    // 3. Fallback to Host IP
    const hostIp = this.getHostPublicIP();
    return `ssh root@${hostIp} -p ${sshPort}`;
  }

  // Create Container with Security Quotas & Hardening
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

        this.run(
          `${this.dockerBin} run -d --name ${name} --hostname ${name} ` +
          `--dns 8.8.8.8 --dns 1.1.1.1 -p ${sshPort}:22 ` +
          `--memory="${memLimit}" --memory-swap="${memLimit}" --cpus="${cpuLimit}" ` +
          `--pids-limit ${pidsLimit} --security-opt no-new-privileges:true ` +
          `${targetImage} sleep infinity`
        );

        this.run(`${this.dockerBin} exec ${name} bash -c "echo 'root:${rootPassword}' | chpasswd"`);

        const selectedTemplate = config.templates[templateKey];
        const templateScript = selectedTemplate && selectedTemplate.script ? selectedTemplate.script : '';

        // Anti-spam outbound port 25 block + base SSH setup
        const initScript = `
          apt-get update -y >/dev/null 2>&1
          apt-get install -y openssh-server curl sudo procps net-tools ca-certificates iptables >/dev/null 2>&1 || true
          mkdir -p /var/run/sshd /root/.ssh
          chmod 700 /root/.ssh
          touch /root/.ssh/authorized_keys
          chmod 600 /root/.ssh/authorized_keys
          sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config 2>/dev/null || true
          sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config 2>/dev/null || true
          iptables -A OUTPUT -p tcp --dport 25 -j REJECT 2>/dev/null || true
          service ssh restart >/dev/null 2>&1 || /etc/init.d/ssh restart >/dev/null 2>&1 || true
          ${templateScript}
        `;

        exec(`${this.dockerBin} exec ${name} bash -c "${initScript.replace(/\n/g, ' ')}"`);

        exec(
          `nohup ttyd -p ${webPort} -i 127.0.0.1 -c root:${rootPassword} -W ${this.dockerBin} exec -it ${name} bash > /tmp/ttyd_${name}.log 2>&1 &`
        );

        let webTerminalUrl = await this.createPublicTunnel(name, webPort);
        if (!webTerminalUrl) webTerminalUrl = this.getWebTerminalUrl(webPort);

        return { success: true, password: rootPassword, sshPort, webPort, webTerminalUrl, hostIp };
      } catch (err) {
        try { this.run(`${this.dockerBin} rm -f ${name}`); } catch {}
        throw new Error(`Failed to create Docker VPS: ${err.message}`);
      }
    } else {
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

        const webTerminalUrl = this.getWebTerminalUrl(22);
        return { success: true, password: rootPassword, sshPort: 22, webPort: null, webTerminalUrl, hostIp };
      } catch (err) {
        try { this.run(`${this.lxcBin} delete -f ${name}`); } catch {}
        throw new Error(`Failed to create LXD VPS: ${err.message}`);
      }
    }
  }

  start(name) {
    if (this.engine === 'docker') {
      this.run(`${this.dockerBin} start ${name}`);
    } else {
      this.run(`${this.lxcBin} start ${name}`);
    }
  }

  updateContainerResources(name, ram, cpu) {
    const memLimit = this.formatDockerMemory(ram);
    const cpuLimit = cpu || '1';

    if (this.engine === 'docker') {
      try {
        this.run(`${this.dockerBin} update --memory="${memLimit}" --memory-swap="${memLimit}" --cpus="${cpuLimit}" ${name}`);
        return true;
      } catch (err) {
        throw new Error(`Failed to update Docker resources: ${err.message}`);
      }
    } else {
      try {
        if (cpu) this.run(`${this.lxcBin} config set ${name} limits.cpu ${cpu}`);
        if (ram) this.run(`${this.lxcBin} config set ${name} limits.memory ${ram}`);
        return true;
      } catch (err) {
        throw new Error(`Failed to update LXD resources: ${err.message}`);
      }
    }
  }

  stop(name) {
    if (this.engine === 'docker') {
      this.run(`${this.dockerBin} stop ${name}`);
      exec(`pkill -f "ttyd.*${name}" 2>/dev/null || true`);
    } else {
      this.run(`${this.lxcBin} stop ${name} --force`);
    }

    if (this.workerBridges[name]) {
      if (this.workerBridges[name].pingInterval) clearInterval(this.workerBridges[name].pingInterval);
      try { this.workerBridges[name].ws.close(); } catch {}
      try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
      delete this.workerBridges[name];
    }

    for (const key of Object.keys(this.tunnels)) {
      if (key.startsWith(name)) {
        try { this.tunnels[key].kill(); } catch {}
        try { this.tunnels[key].close(); } catch {}
        delete this.tunnels[key];
      }
    }

    if (this.ngrokListeners[`${name}_tcp`]) {
      try { this.ngrokListeners[`${name}_tcp`].close(); } catch {}
      delete this.ngrokListeners[`${name}_tcp`];
    }
    if (this.ngrokListeners[`${name}_http`]) {
      try { this.ngrokListeners[`${name}_http`].close(); } catch {}
      delete this.ngrokListeners[`${name}_http`];
    }
  }

  restart(name) {
    this.stop(name);
    this.start(name);
  }

  delete(name) {
    if (this.engine === 'docker') {
      exec(`pkill -f "ttyd.*${name}" 2>/dev/null || true`);
      this.run(`${this.dockerBin} rm -f ${name}`);
    } else {
      this.run(`${this.lxcBin} delete -f ${name}`);
    }

    if (this.workerBridges[name]) {
      if (this.workerBridges[name].pingInterval) clearInterval(this.workerBridges[name].pingInterval);
      try { this.workerBridges[name].ws.close(); } catch {}
      try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
      delete this.workerBridges[name];
    }

    for (const key of Object.keys(this.tunnels)) {
      if (key.startsWith(name)) {
        try { this.tunnels[key].kill(); } catch {}
        try { this.tunnels[key].close(); } catch {}
        delete this.tunnels[key];
      }
    }

    if (this.ngrokListeners[`${name}_tcp`]) {
      try { this.ngrokListeners[`${name}_tcp`].close(); } catch {}
      delete this.ngrokListeners[`${name}_tcp`];
    }
    if (this.ngrokListeners[`${name}_http`]) {
      try { this.ngrokListeners[`${name}_http`].close(); } catch {}
      delete this.ngrokListeners[`${name}_http`];
    }

    db.removeVPS(name);
  }

  rebuildContainer(name, image, templateKey = 'none') {
    const vps = db.getVPS(name);
    if (!vps) throw new Error('VPS not found in database.');

    this.delete(name);
    return this.createContainer({
      name,
      image: image || vps.image,
      cpu: vps.cpu,
      ram: vps.ram,
      templateKey: templateKey || vps.template,
    });
  }

  getInfo(name) {
    try {
      if (this.engine === 'docker') {
        const inspectOut = this.run(`${this.dockerBin} inspect ${name}`);
        const data = JSON.parse(inspectOut)[0];
        if (!data) return null;

        const isRunning = data.State?.Running || false;
        const ip = data.NetworkSettings?.IPAddress || 'N/A';
        const portBindings = data.HostConfig?.PortBindings || {};
        const sshPort = portBindings['22/tcp']?.[0]?.HostPort || '22';
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
          memoryUsage: info.state?.memory ? `${Math.round(info.state.memory.usage / 1024 / 1024)} MB` : 'N/A',
          engine: 'LXD',
          hostIp: this.getHostPublicIP(),
        };
      }
    } catch {
      return null;
    }
  }

  getLiveStats(name) {
    try {
      if (this.engine === 'docker') {
        const statsOut = this.run(`${this.dockerBin} stats ${name} --no-stream --format "{{json .}}"`);
        const data = JSON.parse(statsOut.trim());

        const cpuPercentStr = data.CPUPerc || '0%';
        const cpuPercent = parseFloat(cpuPercentStr.replace('%', '')) || 0;
        const memUsageStr = data.MemUsage || '0B / 0B';
        const memPercentStr = data.MemPerc || '0%';
        const memPercent = parseFloat(memPercentStr.replace('%', '')) || 0;
        const netIO = data.NetIO || '0B / 0B';
        const blockIO = data.BlockIO || '0B / 0B';
        const pids = data.PIDs || '0';

        return {
          cpuPercent,
          cpuBar: this.makeProgressBar(cpuPercent),
          memUsageStr,
          memPercent,
          memBar: this.makeProgressBar(memPercent),
          netIO,
          blockIO,
          pids,
        };
      }
    } catch {}

    return {
      cpuPercent: 0,
      cpuBar: this.makeProgressBar(0),
      memUsageStr: 'N/A',
      memPercent: 0,
      memBar: this.makeProgressBar(0),
      netIO: 'N/A',
      blockIO: 'N/A',
      pids: 'N/A',
    };
  }

  execCommand(name, command) {
    const start = Date.now();
    try {
      const output = this.engine === 'docker'
        ? this.run(`${this.dockerBin} exec ${name} bash -c "${command.replace(/"/g, '\\"')}"`, { timeout: 15000 })
        : this.run(`${this.lxcBin} exec ${name} -- bash -c "${command.replace(/"/g, '\\"')}"`, { timeout: 15000 });

      return { stdout: output, stderr: '', exitCode: 0, duration: Date.now() - start };
    } catch (err) {
      return { stdout: err.stdout || '', stderr: err.stderr || err.message, exitCode: err.status || 1, duration: Date.now() - start };
    }
  }

  getLogs(name, lines = 30) {
    try {
      if (this.engine === 'docker') {
        return this.run(`${this.dockerBin} logs --tail ${lines} ${name}`);
      } else {
        return this.run(`${this.lxcBin} exec ${name} -- journalctl -n ${lines} --no-pager`);
      }
    } catch (e) {
      return `Error retrieving logs: ${e.message}`;
    }
  }

  addSshKey(name, sshPublicKey) {
    const key = sshPublicKey.trim().replace(/\r?\n|\r/g, '');
    const cmd = `echo '${key}' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`;
    if (this.engine === 'docker') {
      this.run(`${this.dockerBin} exec ${name} bash -c "${cmd}"`);
    } else {
      this.run(`${this.lxcBin} exec ${name} -- bash -c "${cmd}"`);
    }
    return true;
  }

  exposePort(name, containerPort, protocol = 'tcp') {
    const hostPort = this.getRandomPort(49001, 65000);
    const hostIp = this.getHostPublicIP();
    const proto = protocol.toLowerCase() === 'udp' ? 'UDP' : 'TCP';

    if (this.engine === 'docker') {
      const inspectOut = this.run(`${this.dockerBin} inspect ${name}`);
      const data = JSON.parse(inspectOut)[0];
      const ip = data.NetworkSettings?.IPAddress;
      if (!ip) throw new Error('Container IP not available. Ensure container is running.');

      const socatCmd = proto === 'UDP'
        ? `nohup socat UDP-LISTEN:${hostPort},fork UDP:${ip}:${containerPort} > /tmp/socat_${name}_${hostPort}.log 2>&1 &`
        : `nohup socat TCP-LISTEN:${hostPort},fork,reuseaddr TCP:${ip}:${containerPort} > /tmp/socat_${name}_${hostPort}.log 2>&1 &`;

      exec(socatCmd);

      return {
        hostPort,
        containerPort,
        protocol: proto,
        hostIp,
        publicUrl: proto === 'TCP' ? `http://${hostIp}:${hostPort}` : `${hostIp}:${hostPort} (${proto})`,
      };
    }
  }

  createBackup(name) {
    const timestamp = Date.now();
    const tag = `backup-${name}-${timestamp}`;
    if (this.engine === 'docker') {
      this.run(`${this.dockerBin} commit ${name} ${tag}`);
    } else {
      this.run(`${this.lxcBin} snapshot ${name} ${tag}`);
    }
    return { tag, timestamp };
  }

  restoreBackup(name, tag) {
    if (this.engine === 'docker') {
      const vps = db.getVPS(name);
      this.delete(name);
      return this.createContainer({
        name,
        image: tag,
        cpu: vps.cpu,
        ram: vps.ram,
        templateKey: vps.template,
      });
    } else {
      this.run(`${this.lxcBin} restore ${name} ${tag}`);
      return { success: true };
    }
  }

  getHostStats() {
    const totalMem = Math.round(os.totalmem() / 1024 / 1024 / 1024);
    const freeMem = Math.round(os.freemem() / 1024 / 1024 / 1024);
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);
    const cpuCount = os.cpus().length;
    const loadAvg = os.loadavg().map((l) => l.toFixed(2)).join(', ');
    const uptimeHours = Math.round(os.uptime() / 3600);

    let diskInfo = 'N/A';
    try {
      const df = this.run('df -h / | tail -1').split(/\s+/);
      diskInfo = `${df[2]} / ${df[1]} (${df[4]} used)`;
    } catch {}

    const allVPS = db.getAllVPS();
    const runningCount = allVPS.filter((v) => this.getInfo(v.containerName)?.status === 'Running').length;

    return {
      totalMem: `${totalMem} GB`,
      usedMem: `${usedMem} GB (${memPercent}%)`,
      memBar: this.makeProgressBar(memPercent),
      cpuCount: `${cpuCount} Cores`,
      loadAvg,
      uptime: `${uptimeHours} hours`,
      diskInfo,
      totalVPS: allVPS.length,
      runningVPS: runningCount,
      publicIp: this.getHostPublicIP(),
    };
  }

  async createWebTerminal(name) {
    const vps = db.getVPS(name);
    if (!vps) throw new Error('VPS not found in database.');

    const webPort = vps.webPort || this.getRandomPort(34001, 49000);
    if (!vps.webPort) {
      db.setVPS(name, { ...vps, webPort });
    }

    exec(
      `nohup ttyd -p ${webPort} -i 127.0.0.1 -c root:${vps.password} -W ${this.dockerBin} exec -it ${name} bash > /tmp/ttyd_${name}.log 2>&1 &`
    );

    const url = await this.createPublicTunnel(name, webPort);
    if (url) {
      db.setVPS(name, { ...vps, webTerminalUrl: url, webPort });
      return url;
    }

    return this.getWebTerminalUrl(webPort);
  }
}

module.exports = new ContainerManager();
