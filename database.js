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
        const parsed = JSON.parse(raw);
        this.data = {
          vps: parsed.vps || {},
          users: parsed.users || {},
        };
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

  // ==========================================
  // VPS Methods
  // ==========================================
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

  // ==========================================
  // Economy & User Methods
  // ==========================================
  getUser(userId) {
    if (!this.data.users[userId]) {
      this.data.users[userId] = {
        userId,
        coins: 100, // Starter bonus
        lastDaily: 0,
        referrals: 0,
        referredBy: null,
      };
      this.save();
    }
    return this.data.users[userId];
  }

  updateUser(userId, fields) {
    const user = this.getUser(userId);
    this.data.users[userId] = { ...user, ...fields };
    this.save();
    return this.data.users[userId];
  }

  addCoins(userId, amount) {
    const user = this.getUser(userId);
    user.coins = Math.max(0, (user.coins || 0) + amount);
    this.save();
    return user.coins;
  }

  getLeaderboard() {
    return Object.values(this.data.users)
      .sort((a, b) => (b.coins || 0) - (a.coins || 0))
      .slice(0, 10);
  }
}

module.exports = new Database();
