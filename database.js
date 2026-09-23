const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'vps_data.json');

class Database {
  constructor() {
    this.data = { vps: {}, users: {} };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        this.data = JSON.parse(raw);
      } else {
        this.save();
      }
    } catch (err) {
      console.error('[DB] Load error:', err.message);
    }
  }

  save() {
    try {
      const tempPath = `${DB_FILE}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempPath, DB_FILE);
    } catch (err) {
      console.error('[DB] Save error:', err.message);
    }
  }

  // Get VPS by container name or user ID
  getVPS(containerName) {
    return this.data.vps[containerName] || null;
  }

  getUserVPSList(userId) {
    return Object.values(this.data.vps).filter((v) => v.ownerId === userId);
  }

  getAllVPS() {
    return Object.values(this.data.vps);
  }

  setVPS(containerName, vpsData) {
    this.data.vps[containerName] = {
      ...vpsData,
      updatedAt: Date.now(),
    };
    this.save();
  }

  removeVPS(containerName) {
    if (this.data.vps[containerName]) {
      delete this.data.vps[containerName];
      this.save();
      return true;
    }
    return false;
  }
}

module.exports = new Database();
