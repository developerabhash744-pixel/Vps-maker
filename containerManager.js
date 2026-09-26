const { execSync, exec, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const config = require('./config');
const db = require('./database');

class ContainerManager {
  constructor() {
    this.engine = this.detectEngine();
    this.cachedIP = null;
    this.tunnels = {};
    this.ngrokListeners = {};
    this.workerBridges = {};
    this.cfTunnels = {};
    this.pinggyTunnels = {};
    this.lhrTunnels = {};
    this.dockerBin = this.resolveBinary('docker', ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker']);
    this.lxcBin = this.resolveBinary('lxc', ['/snap/bin/lxc', '/usr/bin/lxc', '/usr/local/bin/lxc']);
    this.ensureHostTtyd();
    this.ensureCloudflared();
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

  ensureCloudflared() {
    try {
      this.run('command -v cloudflared');
    } catch {
      try {
        const arch = this.run('uname -m').trim();
        const cfArch = arch === 'aarch64' || arch === 'arm64' ? 'arm64' : 'amd64';
        this.run(
          `curl -fsSLo /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfArch}" && chmod +x /usr/local/bin/cloudflared`
        );
      } catch (e) {
        console.warn('[Host cloudflared install note]:', e.message);
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

  // Create ASCII Progress Bar
  makeProgressBar(percent, length = 10) {
    const filled = Math.min(length, Math.max(0, Math.round((percent / 100) * length)));
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
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

      if (this.workerBridges[name]) {
        try { this.workerBridges[name].ws.close(); } catch {}
        try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
        if (this.workerBridges[name].pingInterval) clearInterval(this.workerBridges[name].pingInterval);
        delete this.workerBridges[name];
      }

      ws.on('open', () => {
        console.log(`[Worker Bridge Active for ${name}]: ${webUrl}`);

        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.ping(); } catch {}
          }
        }, 15000);

        const targetCmd = this.engine === 'docker'
          ? `${this.dockerBin} exec -it ${name} bash`
          : `${this.lxcBin} exec ${name} -- bash`;

        const scriptBin = fs.existsSync('/usr/bin/script') ? '/usr/bin/script' : 'script';
        let proc;
        try {
          proc = spawn(scriptBin, ['-qefc', targetCmd, '/dev/null'], {
            env: {
              ...process.env,
              PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin',
              TERM: 'xterm-256color',
              LANG: 'C.UTF-8',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (spawnErr) {
          console.warn('[PTY Spawn Fallback]:', spawnErr.message);
          proc = this.engine === 'docker'
            ? spawn(this.dockerBin, ['exec', '-i', name, 'bash'], { stdio: ['pipe', 'pipe', 'pipe'] })
            : spawn(this.lxcBin, ['exec', name, '--', 'bash'], { stdio: ['pipe', 'pipe', 'pipe'] });
        }

        proc.on('error', (err) => {
          console.warn(`[PTY Error for ${name}]:`, err.message);
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

        proc.on('close', (code) => {
          console.log(`[PTY Closed for ${name}] exit code: ${code}`);
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

  async createCloudflaredTunnel(name, webPort) {
    this.ensureCloudflared();
    return new Promise((resolve) => {
      let resolved = false;
      const proc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${webPort}`, '--no-autoupdate']);

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, 7000);

      const checkUrl = (data) => {
        const text = data.toString();
        const matches = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g);
        if (matches) {
          const tunnelUrl = matches.find((u) => !u.includes('api.trycloudflare.com'));
          if (tunnelUrl && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            this.cfTunnels[name] = proc;
            console.log(`[Cloudflared Quick Tunnel Active for ${name}]:`, tunnelUrl);
            resolve(tunnelUrl);
          }
        }
      };

      proc.stderr.on('data', checkUrl);
      proc.stdout.on('data', checkUrl);
      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          console.warn('[Cloudflared spawn error]:', err.message);
          resolve(null);
        }
      });
    });
  }

  async createPinggyTunnel(name, port, type = 'http') {
    return new Promise((resolve) => {
      let resolved = false;
      const targetHost = type === 'tcp' ? 'tcp@a.pinggy.io' : 'a.pinggy.io';
      const proc = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ServerAliveInterval=30',
        '-p', '443',
        '-R', `0:localhost:${port}`,
        targetHost
      ]);

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, 8000);

      const checkUrl = (data) => {
        const text = data.toString();
        if (type === 'http') {
          const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.pinggy\.link/);
          if (match && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            this.pinggyTunnels[`${name}_http`] = proc;
            console.log(`[Pinggy HTTP Tunnel Active for ${name}]:`, match[0]);
            resolve(match[0]);
          }
        } else {
          const sshMatch = text.match(/ssh\s+-p\s+(\d+)\s+([a-zA-Z0-9-@._]+)/);
          const tcpMatch = text.match(/([a-zA-Z0-9-]+\.pinggy\.link):(\d+)/);
          if (sshMatch && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            this.pinggyTunnels[`${name}_tcp`] = proc;
            const fullCmd = `ssh -p ${sshMatch[1]} root@${sshMatch[2].replace(/^[^@]+@/, '')}`;
            console.log(`[Pinggy SSH Tunnel Active for ${name}]:`, fullCmd);
            resolve({ command: fullCmd, port: sshMatch[1], host: sshMatch[2] });
          } else if (tcpMatch && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            this.pinggyTunnels[`${name}_tcp`] = proc;
            const fullCmd = `ssh -p ${tcpMatch[2]} root@${tcpMatch[1]}`;
            console.log(`[Pinggy SSH Tunnel Active for ${name}]:`, fullCmd);
            resolve({ command: fullCmd, port: tcpMatch[2], host: tcpMatch[1] });
          }
        }
      };

      proc.stdout.on('data', checkUrl);
      proc.stderr.on('data', checkUrl);
      proc.on('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        }
      });
    });
  }

  async createLocalhostRunTunnel(name, port) {
    return new Promise((resolve) => {
      let resolved = false;
      const proc = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ServerAliveInterval=30',
        '-R', `80:localhost:${port}`,
        'nokey@localhost.run'
      ]);

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, 8000);

      const checkUrl = (data) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.(localhost\.run|lhr\.life)/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.lhrTunnels[name] = proc;
          console.log(`[Localhost.run Tunnel Active for ${name}]:`, match[0]);
          resolve(match[0]);
        }
      };

      proc.stdout.on('data', checkUrl);
      proc.stderr.on('data', checkUrl);
      proc.on('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        }
      });
    });
  }

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
      console.warn(`[Ngrok ${proto} tunnel error for ${name}]:`, e.message);
    }
    return null;
  }

  // 2. Public Tunnel Manager
  async createPublicTunnel(name, webPort) {
    // 1. First priority: Ngrok HTTP if token is provided
    if (config.ngrokAuthToken || process.env.NGROK_AUTHTOKEN) {
      try {
        const ngrokUrl = await this.createNgrokTunnel(name, webPort, 'http');
        if (ngrokUrl) return ngrokUrl;
      } catch {}
    }

    // 2. Try Pinggy HTTP (over port 443 SSH)
    try {
      const pinggyUrl = await this.createPinggyTunnel(name, webPort, 'http');
      if (pinggyUrl) return pinggyUrl;
    } catch {}

    // 3. Try Localhost.run (over SSH)
    try {
      const lhrUrl = await this.createLocalhostRunTunnel(name, webPort);
      if (lhrUrl) return lhrUrl;
    } catch {}

    // 4. Try Cloudflare Quick Tunnel (cloudflared)
    try {
      const cfUrl = await this.createCloudflaredTunnel(name, webPort);
      if (cfUrl) return cfUrl;
    } catch (e) {
      console.warn('[Cloudflared tunnel attempt]:', e.message);
    }

    return this.getWebTerminalUrl(webPort);
  }

  async createPublicSsh(name, sshPort) {
    // 1. First priority: Ngrok TCP tunnel if token is provided
    if (config.ngrokAuthToken || process.env.NGROK_AUTHTOKEN) {
      try {
        const ngrokSsh = await this.createNgrokTunnel(name, sshPort, 'tcp');
        if (ngrokSsh && ngrokSsh.command) return ngrokSsh.command;
      } catch {}
    }

    // 2. Try Pinggy TCP Reverse Tunnel
    try {
      const pinggySsh = await this.createPinggyTunnel(name, sshPort, 'tcp');
      if (pinggySsh && pinggySsh.command) return pinggySsh.command;
    } catch {}

    const hostIp = this.getHostPublicIP();
    return `ssh root@${hostIp} -p ${sshPort}`;
  }

  // Create Container with Strict Security Quotas & Templates
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

        const webTerminalUrl = this.createWorkerBridge(name) || this.getWebTerminalUrl(22);
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
      if (config.proxyUrl) setTimeout(() => this.createWorkerBridge(name), 1000);
    } else {
      this.run(`${this.lxcBin} start ${name}`);
      if (config.proxyUrl) setTimeout(() => this.createWorkerBridge(name), 1000);
    }
  }

  // Dynamically update container CPU and RAM (Invite Boosters)
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
      if (this.workerBridges[name]) {
        if (this.workerBridges[name].pingInterval) clearInterval(this.workerBridges[name].pingInterval);
        try { this.workerBridges[name].ws.close(); } catch {}
        try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
        delete this.workerBridges[name];
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
      exec(`pkill -f "socat.*${name}" 2>/dev/null || true`);
      if (this.workerBridges[name]) {
        if (this.workerBridges[name].pingInterval) clearInterval(this.workerBridges[name].pingInterval);
        try { this.workerBridges[name].ws.close(); } catch {}
        try { this.workerBridges[name].proc.kill('SIGKILL'); } catch {}
        delete this.workerBridges[name];
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

  // Live Stats Monitoring with Progress Bars
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
          cpuPercentStr,
          cpuBar: this.makeProgressBar(cpuPercent),
          memUsageStr,
          memPercent,
          memPercentStr,
          memBar: this.makeProgressBar(memPercent),
          netIO,
          blockIO,
          pids,
          status: 'Running',
        };
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  // In-Discord Command Execution (with security blacklist check)
  async execCommand(name, command) {
    // Check command against security blacklist
    for (const pattern of config.commandBlacklist) {
      if (command.includes(pattern)) {
        throw new Error(`Command blocked by security filter (contains restricted pattern: \`${pattern}\`)`);
      }
    }

    return new Promise((resolve) => {
      const cmd = `${this.dockerBin} exec ${name} bash -c ${JSON.stringify(command)}`;
      const startTime = Date.now();
      exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
        const duration = Date.now() - startTime;
        resolve({
          stdout: stdout ? stdout.trim() : '',
          stderr: stderr ? stderr.trim() : (error ? error.message : ''),
          exitCode: error ? (error.code || 1) : 0,
          duration,
        });
      });
    });
  }

  // Fetch Container Logs
  getLogs(name, lines = 50) {
    try {
      if (this.engine === 'docker') {
        const logs = this.run(`${this.dockerBin} logs --tail ${lines} ${name} 2>&1`);
        return logs.trim() || 'No recent container logs recorded.';
      }
    } catch (err) {
      return `Error retrieving logs: ${err.message}`;
    }
    return 'Logs not available for this container.';
  }

  // Add SSH Public Key to Container
  addSshKey(name, publicKey) {
    const cleanKey = publicKey.trim().replace(/[\r\n]+/g, '');
    if (!cleanKey.startsWith('ssh-') && !cleanKey.startsWith('ecdsa-')) {
      throw new Error('Invalid SSH public key format (must start with ssh-rsa, ssh-ed25519, etc.).');
    }
    this.run(
      `${this.dockerBin} exec ${name} bash -c "mkdir -p /root/.ssh && echo '${cleanKey}' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"`
    );
    return true;
  }

  // Reset Root Password
  resetPassword(name, newPassword = null) {
    const password = newPassword || this.generatePassword();
    this.run(`${this.dockerBin} exec ${name} bash -c "echo 'root:${password}' | chpasswd"`);
    return password;
  }

  // Factory Reset / Rebuild Container OS
  rebuildContainer(name, image = config.defaultImage, templateKey = 'none') {
    const vps = db.getVPS(name);
    if (!vps) throw new Error('VPS not found.');

    const plan = config.plans[vps.plan] || config.plans.free;
    this.delete(name);

    return this.createContainer({
      name,
      image,
      cpu: plan.cpu,
      ram: plan.ram,
      templateKey,
    });
  }

  // Create Snapshot Backup
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

  // Expose TCP or UDP Port
  exposePort(name, containerPort, protocol = 'tcp') {
    const hostPort = this.getRandomPort(30000, 45000);
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

  // Host Server System Health Metrics
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

    // Ensure ttyd is running on localhost
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
