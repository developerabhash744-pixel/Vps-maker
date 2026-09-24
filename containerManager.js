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

  generatePassword(length = 14) {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
      password += charset[bytes[i] % charset.length];
    }
    return password;
  }

  getRandomPort() {
    return Math.floor(Math.random() * (45000 - 20000) + 20000);
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

  async createContainer({ name, image, cpu, ram }) {
    const rootPassword = this.generatePassword();
    const targetImage = this.formatImage(image);
    const sshPort = this.getRandomPort();

    if (this.engine === 'docker') {
      try {
        const memLimit = this.formatDockerMemory(ram);
        const cpuLimit = cpu || '1';

        // 1. Launch container with exposed SSH port & persistent background process
        this.run(
          `docker run -d --name ${name} --hostname ${name} -p ${sshPort}:22 --memory="${memLimit}" --cpus="${cpuLimit}" ${targetImage} sleep infinity`
        );

        // 2. Set root password
        this.run(`docker exec ${name} bash -c "echo 'root:${rootPassword}' | chpasswd"`);

        // 3. Setup SSH, curl, and sshx in the background
        const initScript = `
          apt-get update -y >/dev/null 2>&1
          apt-get install -y openssh-server curl sudo procps net-tools ca-certificates >/dev/null 2>&1
          mkdir -p /var/run/sshd
          sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config 2>/dev/null || true
          sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config 2>/dev/null || true
          service ssh restart >/dev/null 2>&1 || /etc/init.d/ssh restart >/dev/null 2>&1 || true
          curl -sSf https://sshx.io/get | sh >/dev/null 2>&1 || true
          cp /root/.local/bin/sshx /usr/local/bin/sshx >/dev/null 2>&1 || true
        `;

        exec(`docker exec ${name} bash -c "${initScript.replace(/\n/g, ' ')}"`);

        return {
          success: true,
          password: rootPassword,
          sshPort,
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
        return { success: true, password: rootPassword, sshPort: 22 };
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
        const portBinding = data.HostConfig?.PortBindings?.['22/tcp']?.[0]?.HostPort || 'N/A';

        return {
          name,
          status: isRunning ? 'Running' : 'Stopped',
          ipv4: ip,
          sshPort: portBinding,
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
    return new Promise((resolve, reject) => {
      const script = `
        export PATH="/usr/local/bin:/root/.local/bin:$PATH"
        pkill -9 -f sshx 2>/dev/null || true
        if ! command -v sshx >/dev/null 2>&1; then
          apt-get update -y >/dev/null 2>&1 && apt-get install -y curl ca-certificates >/dev/null 2>&1
          curl -sSf https://sshx.io/get | sh >/dev/null 2>&1
          cp /root/.local/bin/sshx /usr/local/bin/sshx 2>/dev/null || true
        fi
        rm -f /tmp/.sshx.log
        nohup sshx > /tmp/.sshx.log 2>&1 &
        for i in 1 2 3 4 5 6 7 8 9 10; do
          sleep 1
          LINK=$(grep -o 'https://sshx.io/s/[^ ]*' /tmp/.sshx.log 2>/dev/null | head -n 1)
          if [ -n "$LINK" ]; then
            echo "$LINK"
            exit 0
          fi
        done
        cat /tmp/.sshx.log 2>/dev/null
      `;

      const execCmd =
        this.engine === 'docker'
          ? `docker exec ${name} bash -c "${script.replace(/\n/g, ' ')}"`
          : `${fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc'} exec ${name} -- bash -c "${script.replace(/\n/g, ' ')}"`;

      exec(execCmd, { timeout: 25000 }, (err, stdout) => {
        const link = (stdout || '').trim();
        const matched = link.match(/https:\/\/sshx\.io\/s\/[^\s\x1b]+/);
        if (matched && matched[0]) {
          resolve(matched[0]);
        } else {
          reject(new Error(link || 'Web terminal session could not be established.'));
        }
      });
    });
  }
}

module.exports = new ContainerManager();
