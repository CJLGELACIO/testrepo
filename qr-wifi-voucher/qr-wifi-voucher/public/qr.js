/*! Small QR Code generator: byte mode, versions 1-40, error correction L/M/Q/H.
 *  Follows the QR Code Model 2 specification (ISO/IEC 18004). No dependencies;
 *  runs in browsers (window.QR) and Node (require).
 *
 *    QR.encode(text, { ecl: 'M' })  -> { version, size, mask, modules }  (modules[y][x] is true for dark)
 *    QR.toSvg(text, { ecl: 'M', border: 4 })  -> SVG markup string
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ECC = { L: 0, M: 1, Q: 2, H: 3 };
  var ECC_FORMAT_BITS = [1, 0, 3, 2];

  // Indexed [ecc level][version]; index 0 of each row is unused.
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];

  function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
  }

  function getNumRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function getNumDataCodewords(ver, ecl) {
    return Math.floor(getNumRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  }

  // ---- Reed-Solomon over GF(2^8) with polynomial 0x11D ----

  function rsMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function reedSolomonComputeDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var d = 0; d < degree; d++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = rsMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }

  function reedSolomonComputeRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) {
        result[i] ^= rsMultiply(coef, factor);
      });
    });
    return result;
  }

  function addEccAndInterleave(data, ver, ecl) {
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    var rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var blocks = [];
    var rsDiv = reedSolomonComputeDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = reedSolomonComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (var col = 0; col < blocks[0].length; col++) {
      for (var j = 0; j < blocks.length; j++) {
        if (col !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][col]);
      }
    }
    return result;
  }

  // ---- Matrix construction ----

  function penaltyScore(m, size) {
    var result = 0;
    var x, y, a, b;
    for (var pass = 0; pass < 2; pass++) {
      for (a = 0; a < size; a++) {
        var run = 1;
        var line = '';
        for (b = 0; b < size; b++) {
          var cur = pass === 0 ? m[a][b] : m[b][a];
          line += cur ? '1' : '0';
          if (b > 0) {
            var prev = pass === 0 ? m[a][b - 1] : m[b - 1][a];
            if (cur === prev) {
              run++;
              if (run === 5) result += 3;
              else if (run > 5) result += 1;
            } else {
              run = 1;
            }
          }
        }
        for (var i = 0; i + 11 <= size; i++) {
          var w = line.substr(i, 11);
          if (w === '10111010000' || w === '00001011101') result += 40;
        }
      }
    }
    var dark = 0;
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) {
        if (m[y][x]) dark++;
        if (x < size - 1 && y < size - 1) {
          var c = m[y][x];
          if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
        }
      }
    }
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    if (k > 0) result += k * 10;
    return result;
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(text));
    return Array.prototype.slice.call(Buffer.from(text, 'utf8'));
  }

  function encode(text, options) {
    var opts = options || {};
    var eclName = String(opts.ecl || 'M').toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(ECC, eclName)) throw new RangeError('ecl must be L, M, Q or H');
    var ecl = ECC[eclName];
    var data = utf8Bytes(String(text));

    var ver;
    var minVer = opts.minVersion || 1;
    var maxVer = opts.maxVersion || 40;
    for (ver = minVer; ; ver++) {
      if (ver > maxVer) throw new RangeError('Text is too long for a QR code at this error-correction level');
      var ccBits = ver <= 9 ? 8 : 16;
      var needed = 4 + ccBits + data.length * 8;
      if (data.length < (1 << ccBits) && needed <= getNumDataCodewords(ver, ecl) * 8) break;
    }

    var bits = [];
    function put(val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }
    put(0x4, 4);
    put(data.length, ver <= 9 ? 8 : 16);
    data.forEach(function (b) { put(b, 8); });
    var capBits = getNumDataCodewords(ver, ecl) * 8;
    put(0, Math.min(4, capBits - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (var pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) put(pad, 8);

    var dataCodewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      dataCodewords.push(byte);
    }
    var allCodewords = addEccAndInterleave(dataCodewords, ver, ecl);

    var size = ver * 4 + 17;
    var modules = [];
    var isFunction = [];
    for (var y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFunction.push(new Array(size).fill(false));
    }

    function setFunctionModule(x, y2, dark) {
      modules[y2][x] = dark;
      isFunction[y2][x] = true;
    }

    function drawFinderPattern(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          var xx = cx + dx;
          var yy = cy + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }

    function drawAlignmentPattern(cx, cy) {
      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
          setFunctionModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }

    function alignmentPositions() {
      if (ver === 1) return [];
      var numAlign = Math.floor(ver / 7) + 2;
      var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
      var result = [6];
      for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
      return result;
    }

    function drawFormatBits(mask) {
      var d = (ECC_FORMAT_BITS[ecl] << 3) | mask;
      var rem = d;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var fb = ((d << 10) | rem) ^ 0x5412;
      var n;
      for (n = 0; n <= 5; n++) setFunctionModule(8, n, getBit(fb, n));
      setFunctionModule(8, 7, getBit(fb, 6));
      setFunctionModule(8, 8, getBit(fb, 7));
      setFunctionModule(7, 8, getBit(fb, 8));
      for (n = 9; n < 15; n++) setFunctionModule(14 - n, 8, getBit(fb, n));
      for (n = 0; n < 8; n++) setFunctionModule(size - 1 - n, 8, getBit(fb, n));
      for (n = 8; n < 15; n++) setFunctionModule(8, size - 15 + n, getBit(fb, n));
      setFunctionModule(8, size - 8, true);
    }

    function drawVersion() {
      if (ver < 7) return;
      var rem = ver;
      for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vb = (ver << 12) | rem;
      for (var n = 0; n < 18; n++) {
        var dark = getBit(vb, n);
        var a = size - 11 + (n % 3);
        var b = Math.floor(n / 3);
        setFunctionModule(a, b, dark);
        setFunctionModule(b, a, dark);
      }
    }

    // function patterns
    for (var t = 0; t < size; t++) {
      setFunctionModule(6, t, t % 2 === 0);
      setFunctionModule(t, 6, t % 2 === 0);
    }
    drawFinderPattern(3, 3);
    drawFinderPattern(size - 4, 3);
    drawFinderPattern(3, size - 4);
    var align = alignmentPositions();
    for (var ai = 0; ai < align.length; ai++) {
      for (var aj = 0; aj < align.length; aj++) {
        var corner = (ai === 0 && aj === 0) || (ai === 0 && aj === align.length - 1) || (ai === align.length - 1 && aj === 0);
        if (!corner) drawAlignmentPattern(align[ai], align[aj]);
      }
    }
    drawFormatBits(0);
    drawVersion();

    // codewords in the zigzag order
    var bitIndex = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var jj = 0; jj < 2; jj++) {
          var x = right - jj;
          var upward = ((right + 1) & 2) === 0;
          var yy = upward ? size - 1 - vert : vert;
          if (!isFunction[yy][x] && bitIndex < allCodewords.length * 8) {
            modules[yy][x] = getBit(allCodewords[bitIndex >>> 3], 7 - (bitIndex & 7));
            bitIndex++;
          }
        }
      }
    }

    function applyMask(mask) {
      for (var my = 0; my < size; my++) {
        for (var mx = 0; mx < size; mx++) {
          var invert;
          switch (mask) {
            case 0: invert = (mx + my) % 2 === 0; break;
            case 1: invert = my % 2 === 0; break;
            case 2: invert = mx % 3 === 0; break;
            case 3: invert = (mx + my) % 3 === 0; break;
            case 4: invert = (Math.floor(mx / 3) + Math.floor(my / 2)) % 2 === 0; break;
            case 5: invert = ((mx * my) % 2) + ((mx * my) % 3) === 0; break;
            case 6: invert = (((mx * my) % 2) + ((mx * my) % 3)) % 2 === 0; break;
            default: invert = (((mx + my) % 2) + ((mx * my) % 3)) % 2 === 0; break;
          }
          if (!isFunction[my][mx] && invert) modules[my][mx] = !modules[my][mx];
        }
      }
    }

    var mask = typeof opts.mask === 'number' && opts.mask >= 0 && opts.mask <= 7 ? opts.mask : -1;
    if (mask === -1) {
      var best = Infinity;
      for (var candidate = 0; candidate < 8; candidate++) {
        applyMask(candidate);
        drawFormatBits(candidate);
        var score = penaltyScore(modules, size);
        if (score < best) {
          best = score;
          mask = candidate;
        }
        applyMask(candidate);
      }
    }
    applyMask(mask);
    drawFormatBits(mask);

    return { version: ver, size: size, mask: mask, ecl: eclName, modules: modules };
  }

  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toSvg(text, options) {
    var opts = options || {};
    var border = opts.border == null ? 4 : opts.border;
    var qr = encode(text, opts);
    var dim = qr.size + border * 2;
    var parts = [];
    for (var y = 0; y < qr.size; y++) {
      var x = 0;
      while (x < qr.size) {
        if (!qr.modules[y][x]) { x++; continue; }
        var end = x;
        while (end < qr.size && qr.modules[y][end]) end++;
        parts.push('M' + (x + border) + ',' + (y + border) + 'h' + (end - x) + 'v1h-' + (end - x) + 'z');
        x = end;
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" ' +
      'shape-rendering="crispEdges" role="img" aria-label="' + escapeAttr(opts.title || 'QR code') + '">' +
      '<rect width="100%" height="100%" fill="#ffffff"/>' +
      '<path d="' + parts.join('') + '" fill="#000000"/></svg>';
  }

  return {
    encode: encode,
    toSvg: toSvg,
    ECC: ECC,
    _internals: {
      penaltyScore: penaltyScore,
      getNumDataCodewords: getNumDataCodewords,
      reedSolomonComputeDivisor: reedSolomonComputeDivisor,
      reedSolomonComputeRemainder: reedSolomonComputeRemainder
    }
  };
}));
