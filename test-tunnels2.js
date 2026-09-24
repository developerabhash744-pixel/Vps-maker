const { exec, spawn } = require('child_process');

console.log('Testing active tunnels with proper execution...\n');

// 1. Test serveo
function testServeo() {
  return new Promise((resolve) => {
    console.log('Testing Serveo (SSH)...');
    const proc = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-R', '80:localhost:7681',
      'serveo.net'
    ]);

    let out = '';
    let resolved = false;

    proc.stdout.on('data', (d) => {
      out += d.toString();
      const match = out.match(/https?:\/\/[a-zA-Z0-9-]+\.serveo\.net/);
      if (match && !resolved) {
        resolved = true;
        resolve({ ok: true, url: match[0] });
        proc.kill('SIGKILL');
      }
    });

    proc.stderr.on('data', (d) => {
      out += d.toString();
      const match = out.match(/https?:\/\/[a-zA-Z0-9-]+\.serveo\.net/);
      if (match && !resolved) {
        resolved = true;
        resolve({ ok: true, url: match[0] });
        proc.kill('SIGKILL');
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGKILL');
        resolve({ ok: false, output: out.replace(/\n/g, ' ').slice(0, 100) });
      }
    }, 8000);
  });
}

// 2. Test pinggy
function testPinggy() {
  return new Promise((resolve) => {
    console.log('Testing Pinggy (SSH)...');
    const proc = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-p', '443',
      '-R', '0:localhost:7681',
      'a.pinggy.io'
    ]);

    let out = '';
    let resolved = false;

    proc.stdout.on('data', (d) => {
      out += d.toString();
      const match = out.match(/https:\/\/[a-zA-Z0-9-]+\.(?:a\.)?pinggy\.link/);
      if (match && !resolved) {
        resolved = true;
        resolve({ ok: true, url: match[0] });
        proc.kill('SIGKILL');
      }
    });

    proc.stderr.on('data', (d) => {
      out += d.toString();
      const match = out.match(/https:\/\/[a-zA-Z0-9-]+\.(?:a\.)?pinggy\.link/);
      if (match && !resolved) {
        resolved = true;
        resolve({ ok: true, url: match[0] });
        proc.kill('SIGKILL');
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGKILL');
        resolve({ ok: false, output: out.replace(/\n/g, ' ').slice(0, 100) });
      }
    }, 8000);
  });
}

async function main() {
  const s = await testServeo();
  if (s.ok) {
    console.log(`✅ Serveo Tunnel Active: ${s.url}\n`);
  } else {
    console.log(`❌ Serveo failed: ${s.output}\n`);
  }

  const p = await testPinggy();
  if (p.ok) {
    console.log(`✅ Pinggy Tunnel Active: ${p.url}\n`);
  } else {
    console.log(`❌ Pinggy failed: ${p.output}\n`);
  }
}

main();
