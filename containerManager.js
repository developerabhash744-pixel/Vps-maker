const { execSync, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

class ContainerManager {
  constructor() {
    this.engine = this.detectEngine();
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
        return 'docker'; // default fallback
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

  generatePassword(length = 14) {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
      password += charset[bytes[i] % charset.length];
    }
    return password;
  }

  // Format RAM string for Docker (e.g., '1GiB' -> '1g')
  formatDockerMemory(ram) {
    if (!ram) return '1g';
    return ram.toLowerCase().replace('gib', 'g').replace('mib', 'm');
  }

  // Format OS image name for Docker or LXD
  formatImage(image) {
    if (this.engine === 'docker') {
      if (image === 'ubuntu:24.04' || image === 'ubuntu:22.04') return image;
      if (image.includes('debian')) return 'debian:12';
      return image.replace('images:', '');
    }
    return image;
  }

  async createContainer({ name, image, cpu, ram }) {
    const rootPassword = this.generatePassword();
    const targetImage = this.formatImage(image);

    if (this.engine === 'docker') {
      try {
        const memLimit = this.formatDockerMemory(ram);
        const cpuLimit = cpu || '1';

        // 1. Run container in background with persistent init
        this.run(
          `docker run -d --name ${name} --hostname ${name} --memory="${memLimit}" --cpus="${cpuLimit}" ${targetImage} sleep infinity`
        );

        // 2. Setup root password and basic tools
        this.run(`docker exec ${name} bash -c "echo 'root:${rootPassword}' | chpasswd"`);
        
        // Background package setup so container is immediately responsive
        exec(
          `docker exec ${name} bash -c "apt-get update -y && apt-get install -y openssh-server curl sudo procps net-tools"`
        );

        return { success: true, password: rootPassword };
      } catch (err) {
        try {
          this.run(`docker rm -f ${name}`);
        } catch {}
        throw new Error(`Failed to create Docker VPS: ${err.message}`);
      }
    } else {
      // LXD Engine
      const lxcBin = fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc';
      try {
        this.run(`${lxcBin} launch ${targetImage} ${name}`);
        if (cpu) this.run(`${lxcBin} config set ${name} limits.cpu ${cpu}`);
        if (ram) this.run(`${lxcBin} config set ${name} limits.memory ${ram}`);
        this.run(`${lxcBin} exec ${name} -- bash -c "echo 'root:${rootPassword}' | chpasswd"`);
        return { success: true, password: rootPassword };
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

        return {
          name,
          status: isRunning ? 'Running' : 'Stopped',
          ipv4: ip,
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
          memoryUsage: info.state?.memory?.usage ? `${Math.round(info.state.memory.usage / 1024 / 1024)} MB` : 'N/A',
          engine: 'LXD',
        };
      }
    } catch {
      return null;
    }
  }

  async createWebTerminal(name) {
    return new Promise((resolve, reject) => {
      const script = `
        if ! command -v sshx >/dev/null 2>&1; then
          apt-get update -y >/dev/null 2>&1 && apt-get install -y curl >/dev/null 2>&1
          curl -sSf https://sshx.io/get | sh >/dev/null 2>&1
        fi
        nohup sshx > /tmp/.sshx.log 2>&1 &
        sleep 3
        grep -o 'https://sshx.io/s/[^ ]*' /tmp/.sshx.log | head -n 1
      `;

      const execCmd =
        this.engine === 'docker'
          ? `docker exec ${name} bash -c "${script.replace(/\n/g, ' ')}"`
          : `${fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc'} exec ${name} -- bash -c "${script.replace(/\n/g, ' ')}"`;

      exec(execCmd, (err, stdout) => {
        if (err) return reject(new Error('Failed to start web terminal session.'));
        const link = stdout.trim();
        if (link && link.startsWith('https://sshx.io/s/')) {
          resolve(link);
        } else {
          reject(new Error('Web terminal session could not be established. Please try again in 5 seconds.'));
        }
      });
    });
  }
}

module.exports = new ContainerManager();
