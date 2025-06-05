const fs = require('fs');
const path = require('path');

function readCU8File(file) {
  const buffer = fs.readFileSync(file);
  const n = buffer.length / 2;
  const I = new Uint8Array(n), Q = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    I[i] = buffer[2 * i];
    Q[i] = buffer[2 * i + 1];
  }
  return { I, Q };
}

function normalizeIQ(Iu, Qu) {
  const n = Iu.length;
  const I = new Float32Array(n), Q = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    I[i] = Iu[i] - 128;
    Q[i] = Qu[i] - 128;
  }
  return { I, Q };
}

function computePower(I, Q) {
  const n = I.length;
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    p[i] = I[i] * I[i] + Q[i] * Q[i];
  }
  return p;
}

function detectSignal(power, threshold) {
  return power.map(v => v > threshold);
}

function findSignalIntervals(isSig, minLen) {
  const intervals = [];
  const len = isSig.length;
  let inSig = false;
  let start = 0;
  for (let i = 0; i < len; i++) {
    if (!inSig && isSig[i]) {
      inSig = true;
      start = i;
    }
    if (inSig && !isSig[i]) {
      const end = i - 1;
      if (end - start + 1 >= minLen) intervals.push([start, end]);
      inSig = false;
    }
  }
  if (inSig) {
    const end = len - 1;
    if (end - start + 1 >= minLen) intervals.push([start, end]);
  }
  return intervals;
}

function computePhases(I, Q) {
  const n = I.length;
  const ph = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ph[i] = Math.atan2(Q[i], I[i]);
  }
  return ph;
}

function computePhaseDiff(phases) {
  const n = phases.length;
  const dp = new Float32Array(n);
  dp[0] = 0;
  for (let i = 1; i < n; i++) {
    let d = phases[i] - phases[i - 1];
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    dp[i] = d;
  }
  return dp;
}

function decodeFSK(dphi, start, end, samplesPerBit) {
  const total = end - start + 1;
  const nSymbols = Math.floor(total / samplesPerBit);
  const bits = [];
  for (let s = 0; s < nSymbols; s++) {
    let sum = 0;
    const base = start + s * samplesPerBit;
    for (let k = 0; k < samplesPerBit; k++) {
      sum += dphi[base + k];
    }
    bits.push(sum > 0 ? 1 : 0);
  }
  return bits;
}

function extractUnique64BitSequences(filePath, powerThreshold, minSignalLength, samplesPerBit) {
  const { I: Iu, Q: Qu } = readCU8File(filePath);
  const { I, Q } = normalizeIQ(Iu, Qu);
  const power = computePower(I, Q);
  const isSignal = detectSignal(power, powerThreshold);
  const intervals = findSignalIntervals(isSignal, minSignalLength);
  if (!intervals.length) return [];
  const phases = computePhases(I, Q);
  const dphi = computePhaseDiff(phases);
  const uniqueSequences = new Set();
  intervals.forEach(([start, end]) => {
    const bits = decodeFSK(dphi, start, end, samplesPerBit);
    if (bits.length === 64) {
      uniqueSequences.add(bits.join(''));
    }
  });
  return Array.from(uniqueSequences);
}

function processDirectory(dirPath, powerThreshold, minSignalLength, samplesPerBit) {
  const results = {};
  const files = fs.readdirSync(dirPath);
  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isFile()) {
      results[file] = extractUnique64BitSequences(fullPath, powerThreshold, minSignalLength, samplesPerBit);
    }
  });
  return results;
}

const allSequences = processDirectory(path.join(__dirname, 'samples'), 5, 35000, 635);
console.log(allSequences);
