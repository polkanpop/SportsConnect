// run this send to Ai the logs of this cmd when babel start to acting up ( correct directory: node diagnose-babel.js)
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const entryPath = path.join(__dirname, 'node_modules', 'expo-router', 'entry.js');
const code = fs.readFileSync(entryPath, 'utf8');

console.log('Using @babel/core version:', babel.version);

try {
  const result = babel.transformSync(code, {
    presets: ['babel-preset-expo'],
    filename: entryPath,
    babelrc: false,
    configFile: false,
  });
  console.log('Transform succeeded. Code size:', result.code.length);
} catch (e) {
  console.error('Transform failed:', e.message);
  if (e.codeFrame) console.error(e.codeFrame);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 10).join('\n'));
}
