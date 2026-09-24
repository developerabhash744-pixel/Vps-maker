const { execSync, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');

class ContainerManager {
  constructor() {
    this.engine = this.detectEngine();
    this.cachedIP = null;
  }

  run(command, options = {}) {
    return execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
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
      const ip = this.run('curl -s --connect-timeout 4 https://api.ipify.org || curl -s --connect-timeout 4 https://icanhazip.com || curl -s --connect-timeout 4 https://ifconfig.me').trim();
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

  getRandomPort(min = 20000, max = 35000) {
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
    if (config.daytonaProxy) {
      // Clean base domain (strip any leading port e.g. "22222-")
      const baseDomain = config.daytonaProxy.replace(/^\d+-/, '').replace(/\/+$/, '');
      return `https://${webPort}-${baseDomain}/`;
    }
    const hostIp = this.getHostPublicIP();
    return `http://${hostIp}:${webPort}`;
  }

  async createContainer({ name, image, cpu, ram }) {
    const rootPassword = this.generatePassword();
    const targetImage = this.formatImage(image);
    const sshPort = this.getRandomPort(20000, 34000);
    const webPort = this.getRandomPort(34001, 49000);
    const hostIp = this.getHostPublicIP();

    if (this.engine === 'docker') {
      try {
        const memLimit = this.formatDockerMemory(ram);
        const cpuLimit = cpu || '1';

        // 1. Launch container with exposed SSH and ttyd Web Terminal ports
        this.run(
          `docker run -d --name ${name} --hostname ${name} --dns 8.8.8.8 --dns 1.1.1.1 -p ${sshPort}:22 -p ${webPort}:7681 --memory="${memLimit}" --cpus="${cpuLimit}" ${targetImage} sleep infinity`
        );

        // 2. Set root password
        this.run(`docker exec ${name} bash -c "echo 'root:${rootPassword}' | chpasswd"`);

        // 3. Install SSH server, tools, and native Web Terminal (ttyd)
        const initScript = `
          apt-get update -y >/dev/null 2>&1
          apt-get install -y openssh-server curl sudo procps net-tools ca-certificates ttyd >/dev/null 2>&1 || true
          
          # Fallback: install static ttyd if package repo didn't have it
          if ! command -v ttyd >/dev/null 2>&1; then
            ARCH=$(uname -m)
            curl -fsSLo /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.\${ARCH}" >/dev/null 2>&1 || true
            chmod +x /usr/local/bin/ttyd 2>/dev/null || true
          fi

          mkdir -p /var/run/sshd
          sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config 2>/dev/null || true
          sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config 2>/dev/null || true
          service ssh restart >/dev/null 2>&1 || /etc/init.d/ssh restart >/dev/null 2>&1 || true

          # Start local web terminal daemon
          pkill -f ttyd 2>/dev/null || true
          nohup ttyd -p 7681 -c root:${rootPassword} -W bash >/tmp/.ttyd.log 2>&1 &
        `;

        exec(`docker exec ${name} bash -c "${initScript.replace(/\n/g, ' ')}"`);

        const webTerminalUrl = this.getWebTerminalUrl(webPort);

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
      // Ensure ttyd is running upon container start
      exec(`docker exec ${name} bash -c "pgrep ttyd >/dev/null || (nohup ttyd -p 7681 -W bash >/dev/null 2>&1 &)"`);
    } else {
      const lxcBin = fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc';
      this.run(`${lxcBin} start ${name}`);
    }
  }

  stop(name) {
    if (this.engine === 'docker') {
      this.run(`docker stop ${name}`);
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
        const webPort = data.HostConfig?.PortBindings?.['7681/tcp']?.[0]?.HostPort || null;
        const hostIp = this.getHostPublicIP();

        return {
          name,
          status: isRunning ? 'Running' : 'Stopped',
          ipv4: ip,
          sshPort,
          webPort,
          webTerminalUrl: this.getWebTerminalUrl(webPort),
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
          webPort: null,
          webTerminalUrl: null,
          memoryUsage: info.state?.memory?.usage ? `${Math.round(info.state.memory.usage / 1024 / 1024)} MB` : 'N/A',
          engine: 'LXD',
        };
      }
    } catch {
      return null;
    }
  }

  async createWebTerminal(name) {
    const info = this.getInfo(name);
    if (info && info.webTerminalUrl) {
      return info.webTerminalUrl;
    }
    throw new Error('Web terminal is not configured for this container.');
  }
}

module.exports = new ContainerManager();
