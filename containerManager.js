const { execSync, exec, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');
const db = require('./database');

class ContainerManager {
  constructor() {
    this.engine = this.detectEngine();
    this.cachedIP = null;
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

  // Create free Cloudflare Quick Tunnel for guaranteed global HTTPS web terminal
  async createCloudflareTunnel(name, webPort) {
    return new Promise((resolve) => {
      console.log(`[Cloudflare Tunnel] Starting quick tunnel for ${name} on port ${webPort}...`);

      const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${webPort}`], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.warn(`[Cloudflare Tunnel for ${name} timed out after 18s]`);
          resolve(null);
        }
      }, 18000);

      const checkOutput = (data) => {
        const text = data.toString();
        const matched = text.match(/https:\/\/[-a-zA-Z0-9]+\.trycloudflare\.com/);
        if (matched && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          console.log(`[Cloudflare Tunnel SUCCESS for ${name}]: ${matched[0]}`);
          resolve(matched[0]);
        }
      };

      if (proc.stdout) proc.stdout.on('data', checkOutput);
      if (proc.stderr) proc.stderr.on('data', checkOutput);

      proc.on('error', (err) => {
        console.error(`[Cloudflare Tunnel process error for ${name}]:`, err.message);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        }
      });
    });
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

        // 5. Create Cloudflare Tunnel for universal HTTPS browser access
        let webTerminalUrl = await this.createCloudflareTunnel(name, webPort);
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
        return { success: true, password: rootPassword, sshPort: 22, webPort: null, webTerminalUrl: null, hostIp };
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
    if (vps && vps.webTerminalUrl) {
      return vps.webTerminalUrl;
    }
    throw new Error('Web terminal is not configured for this container.');
  }
}

module.exports = new ContainerManager();
