const { exec } = require('child_process');

console.log('Testing outbound tunnel connections...\n');

const tests = [
  {
    name: '1. Pinggy (SSH port 443)',
    cmd: 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -p 443 -R 0:localhost:7681 a.pinggy.io 2>&1',
    timeout: 6000,
  },
  {
    name: '2. Localhost.run (SSH port 80/443/22)',
    cmd: 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -R 80:localhost:7681 nokey@localhost.run 2>&1',
    timeout: 6000,
  },
  {
    name: '3. Serveo (SSH)',
    cmd: 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -R 80:localhost:7681 serveo.net 2>&1',
    timeout: 6000,
  },
  {
    name: '4. LocalTunnel npm test',
    cmd: 'node -e "require(\'localtunnel\')({port: 7681}).then(t => { console.log(\'LT_URL:\' + t.url); setTimeout(() => process.exit(0), 1000); }).catch(e => console.error(\'LT_ERR:\' + e.message))"',
    timeout: 8000,
  },
  {
    name: '5. Pinggy HTTP (curl)',
    cmd: 'curl -s --connect-timeout 4 https://a.pinggy.io || echo "Pinggy HTTP failed"',
    timeout: 5000,
  },
  {
    name: '6. Ngrok API (curl)',
    cmd: 'curl -s --connect-timeout 4 https://api.ngrok.com || echo "Ngrok API failed"',
    timeout: 5000,
  }
];

async function runTest(test) {
  return new Promise((resolve) => {
    let finished = false;
    const child = exec(test.cmd, (err, stdout, stderr) => {
      if (!finished) {
        finished = true;
        resolve({ stdout, stderr, err });
      }
    });

    setTimeout(() => {
      if (!finished) {
        finished = true;
        try { child.kill('SIGKILL'); } catch {}
        resolve({ stdout: 'TIMED OUT', stderr: '' });
      }
    }, test.timeout);
  });
}

(async () => {
  for (const t of tests) {
    process.stdout.write(`Testing ${t.name}... `);
    const res = await runTest(t);
    const out = (res.stdout + ' ' + (res.stderr || '')).trim();
    if (out.includes('http://') || out.includes('https://') || out.includes('LT_URL:')) {
      console.log(`\n  👉 SUCCESS! Output:\n  ${out.split('\n').slice(0, 3).join('\n  ')}\n`);
    } else {
      console.log(`Output: ${out.replace(/\n/g, ' ').slice(0, 80)}`);
    }
  }
})();
