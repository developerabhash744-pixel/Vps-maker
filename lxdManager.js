const { execSync, exec } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const LXC_BIN = fs.existsSync('/snap/bin/lxc') ? '/snap/bin/lxc' : 'lxc';

class LXDManager {
  // Execute sync command with safety
  run(command, options = {}) {
    return execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
  }

  // Check if LXD is available
  isAvailable() {
    try {
      this.run(`${LXC_BIN} version`);
      return true;
    } catch {
      return false;
    }
  }

  // Generate random safe password
  generatePassword(length = 12) {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
      password += charset[bytes[i] % charset.length];
    }
    return password;
  }

  // Create & Configure a new Container
  async createContainer({ name, image, cpu, ram, disk }) {
    try {
      // 1. Launch container
      this.run(`${LXC_BIN} launch ${image} ${name}`);

      // 2. Set resource limits
      if (cpu) {
        this.run(`${LXC_BIN} config set ${name} limits.cpu ${cpu}`);
      }
      if (ram) {
        this.run(`${LXC_BIN} config set ${name} limits.memory ${ram}`);
      }
      if (disk) {
        try {
          this.run(`${LXC_BIN} config device set ${name} root size ${disk}`);
        } catch (e) {
          // Some storage pools configure root disk differently
          console.warn(`[LXD] Disk quota set note: ${e.message}`);
        }
      }

      // 3. Set hostname cleanly without requiring D-Bus
      try {
        this.run(`${LXC_BIN} exec ${name} -- bash -c "echo '${name}' > /etc/hostname && hostname '${name}'"`);
      } catch (e) {
        console.warn(`[LXD] Hostname set note: ${e.message}`);
      }

      // 4. Generate & set root password
      const rootPassword = this.generatePassword(14);
      this.run(`${LXC_BIN} exec ${name} -- bash -c "echo 'root:${rootPassword}' | chpasswd"`);

      // 5. Ensure SSH & curl are installed
      try {
        this.run(`${LXC_BIN} exec ${name} -- bash -c "apt-get update -y && apt-get install -y openssh-server curl sudo"`);
        this.run(`${LXC_BIN} exec ${name} -- bash -c "sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && systemctl restart ssh || service ssh restart"`);
      } catch (err) {
        console.warn(`[LXD] SSH setup note: ${err.message}`);
      }

      return {
        success: true,
        password: rootPassword,
      };
    } catch (err) {
      // Cleanup on failure
      try {
        this.run(`${LXC_BIN} delete -f ${name}`);
      } catch {}
      throw new Error(`Failed to create container: ${err.message}`);
    }
  }

  // Lifecycle controls
  start(name) {
    this.run(`${LXC_BIN} start ${name}`);
  }

  stop(name, force = false) {
    this.run(`${LXC_BIN} stop ${name} ${force ? '--force' : ''}`);
  }

  restart(name) {
    this.run(`${LXC_BIN} restart ${name}`);
  }

  delete(name) {
    this.run(`${LXC_BIN} delete -f ${name}`);
  }

  // Get status and info
  getInfo(name) {
    try {
      const output = this.run(`${LXC_BIN} list ${name} --format json`);
      const list = JSON.parse(output);
      if (!list || list.length === 0) return null;

      const info = list[0];
      const ipv4 = (info.state?.network?.eth0?.addresses || [])
        .filter((a) => a.family === 'inet')
        .map((a) => a.address)[0] || 'N/A';

      const memUsage = info.state?.memory?.usage
        ? `${Math.round(info.state.memory.usage / 1024 / 1024)} MB`
        : 'N/A';

      return {
        name: info.name,
        status: info.status,
        ipv4,
        memoryUsage: memUsage,
        cpuUsage: info.state?.cpu?.usage ? `${(info.state.cpu.usage / 1e9).toFixed(2)}s` : 'N/A',
      };
    } catch (err) {
      return null;
    }
  }

  // Create temporary web terminal link using sshx
  async createWebTerminal(name) {
    return new Promise((resolve, reject) => {
      // Run sshx inside container and capture stdout link
      const script = `
        if ! command -v sshx >/dev/null 2>&1; then
          curl -sSf https://sshx.io/get | sh >/dev/null 2>&1
        fi
        nohup sshx > /tmp/.sshx.log 2>&1 &
        sleep 3
        grep -o 'https://sshx.io/s/[^ ]*' /tmp/.sshx.log | head -n 1
      `;

      exec(`${LXC_BIN} exec ${name} -- bash -c "${script.replace(/\n/g, ' ')}"`, (err, stdout) => {
        if (err) return reject(new Error('Failed to initialize web terminal session.'));
        const link = stdout.trim();
        if (link && link.startsWith('https://sshx.io/s/')) {
          resolve(link);
        } else {
          reject(new Error('Web terminal link could not be generated. Please try again in a few seconds.'));
        }
      });
    });
  }
}

module.exports = new LXDManager();
