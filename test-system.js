const { execSync, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

function runCmd(cmd) {
  try {
    return { ok: true, output: execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() };
  } catch (err) {
    return { ok: false, output: (err.stderr || err.message || '').toString().trim() };
  }
}

async function testFetch(url, timeout = 5000) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith('https');
    const client = isHttps ? https : http;
    const req = client.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body: data.slice(0, 100) }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Request timed out' });
    });
  });
}

function testSshx() {
  return new Promise((resolve) => {
    const proc = spawn('sshx', ['-q', '--shell', 'echo "test-sshx-session"'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    let out = '';

    proc.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const match = out.match(/https:\/\/sshx\.io\/s\/[^\s\n\r]+/);
      if (match && !resolved) {
        resolved = true;
        try { proc.kill('SIGKILL'); } catch {}
        resolve({ ok: true, url: match[0].trim() });
      }
    });

    proc.stderr.on('data', (chunk) => {
      out += chunk.toString();
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: err.message });
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { proc.kill('SIGKILL'); } catch {}
        resolve({ ok: false, error: 'Timeout waiting for sshx URL', rawOutput: out });
      }
    }, 7000);
  });
}

async function main() {
  console.log('\n======================================================');
  console.log('       🔍 COMPREHENSIVE VPS BOT SYSTEM DIAGNOSTIC');
  console.log('======================================================\n');

  // 1. Binary checks
  console.log('--- 1. System Binaries ---');
  const binaries = ['curl', 'docker', 'node', 'npm', 'pm2', 'sshx', 'ttyd', 'cloudflared'];
  for (const bin of binaries) {
    const res = runCmd(`command -v ${bin}`);
    if (res.ok) {
      console.log(`✅ ${bin.padEnd(12)}: Found at ${res.output}`);
    } else {
      console.log(`❌ ${bin.padEnd(12)}: NOT FOUND`);
    }
  }

  // 2. Docker Daemon Check
  console.log('\n--- 2. Docker Daemon & Containers ---');
  const dockerVer = runCmd('docker --version');
  if (dockerVer.ok) {
    console.log(`✅ Docker CLI : ${dockerVer.output}`);
    const dockerInfo = runCmd('docker info');
    if (dockerInfo.ok) {
      console.log(`✅ Docker Daemon: RUNNING (OK)`);
      const containers = runCmd('docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"');
      console.log(containers.output || 'No containers currently running.');
    } else {
      console.log(`❌ Docker Daemon: NOT RUNNING (run: nohup dockerd >/tmp/docker.log 2>&1 &)`);
    }
  } else {
    console.log(`❌ Docker CLI not installed`);
  }

  // 3. Network Outbound Connectivity
  console.log('\n--- 3. Network Outbound Connectivity ---');
  const testEndpoints = [
    { name: 'GitHub API', url: 'https://api.github.com' },
    { name: 'IPify (Public IP)', url: 'https://api.ipify.org' },
    { name: 'sshx.io Server', url: 'https://sshx.io' },
    { name: 'Discord Gateway Proxy', url: 'https://silent-wind-4838.pabhash015.workers.dev' },
    { name: 'Direct Discord API', url: 'https://discord.com/api/v10/gateway' },
  ];

  for (const ep of testEndpoints) {
    const res = await testFetch(ep.url);
    if (res.ok) {
      console.log(`✅ ${ep.name.padEnd(24)}: HTTP ${res.status} OK`);
    } else {
      console.log(`❌ ${ep.name.padEnd(24)}: FAILED (${res.error || `HTTP ${res.status}`})`);
    }
  }

  // 4. sshx Web Terminal Live Test
  console.log('\n--- 4. Live sshx.io Web Terminal Test ---');
  const sshxRes = await testSshx();
  if (sshxRes.ok) {
    console.log(`✅ sshx.io Web Terminal Test: SUCCESS!`);
    console.log(`   Generated Link: ${sshxRes.url}`);
  } else {
    console.log(`❌ sshx.io Web Terminal Test: FAILED`);
    console.log(`   Reason: ${sshxRes.error || sshxRes.rawOutput}`);
  }

  // 5. Bot Environment & Database
  console.log('\n--- 5. Bot Configuration (.env & Database) ---');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    console.log(`✅ .env configuration file exists.`);
    require('dotenv').config({ path: envPath });
    console.log(`   - DISCORD_TOKEN : ${process.env.DISCORD_TOKEN ? 'Present (Configured)' : 'MISSING'}`);
    console.log(`   - CLIENT_ID     : ${process.env.CLIENT_ID || 'MISSING'}`);
    console.log(`   - GUILD_ID      : ${process.env.GUILD_ID || 'Not set (Global mode)'}`);
    console.log(`   - HOSTING_NAME  : ${process.env.HOSTING_NAME || 'Default'}`);
  } else {
    console.log(`❌ .env file NOT FOUND in ${__dirname}`);
  }

  const dbPath = path.join(__dirname, 'vps_data.json');
  if (fs.existsSync(dbPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      const count = Object.keys(data.vps || {}).length;
      console.log(`✅ Database vps_data.json exists (${count} VPS records found).`);
    } catch {
      console.log(`⚠️ Database vps_data.json exists but could not be parsed.`);
    }
  } else {
    console.log(`ℹ️ Database vps_data.json has not been created yet (will be created automatically).`);
  }

  console.log('\n======================================================');
  console.log('                 DIAGNOSTIC COMPLETE');
  console.log('======================================================\n');
}

main().catch(console.error);
