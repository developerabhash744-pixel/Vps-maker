const { execSync } = require('child_process');

console.log('=== Terminal Diagnostic ===');

try {
  const ttydVer = execSync('ttyd --version', { encoding: 'utf8' }).trim();
  console.log('✅ ttyd installed on host:', ttydVer);
} catch (e) {
  console.error('❌ ttyd is NOT installed on host:', e.message);
  console.log('Attempting to install ttyd on host now...');
  try {
    const arch = execSync('uname -m', { encoding: 'utf8' }).trim();
    execSync(
      `curl -fsSLo /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${arch}" && chmod +x /usr/local/bin/ttyd`,
      { stdio: 'inherit' }
    );
    console.log('✅ ttyd successfully installed to /usr/local/bin/ttyd');
  } catch (err) {
    console.error('Failed to install ttyd:', err.message);
  }
}

try {
  const cfVer = execSync('cloudflared --version', { encoding: 'utf8' }).trim();
  console.log('✅ cloudflared installed on host:', cfVer);
} catch (e) {
  console.error('❌ cloudflared is NOT installed on host:', e.message);
}

try {
  const psOutput = execSync('ps aux | grep -E "ttyd|cloudflared|docker" | grep -v grep', { encoding: 'utf8' });
  console.log('\n--- Active Processes ---');
  console.log(psOutput);
} catch {
  console.log('No active terminal processes found.');
}
