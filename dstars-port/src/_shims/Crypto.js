// Shim for System.Security.Cryptography.MD5 as used by RadarWindow.Initialize() to hash the
// serialized settings string (change detection). C#'s MD5 is synchronous; the browser's
// crypto.subtle.digest is async, so a synchronous MD5 (RFC 1321) is implemented here to keep
// the call-site 1:1. This is used only for an internal "did settings change" fingerprint.
export class MD5 {
    Hash = null; // byte[]
    static Create() { return new MD5(); }
    Initialize() { this.Hash = null; }
    // ComputeHash(byte[]) -> byte[16], also stored in .Hash
    ComputeHash(bytes) { this.Hash = md5bytes(bytes); return this.Hash; }
}

function md5bytes(input) {
    const x = [];
    for (let i = 0; i < input.length; i++) x[i >> 2] = (x[i >> 2] || 0) | (input[i] << ((i % 4) * 8));
    const bitLen = input.length * 8;
    let i = input.length; x[i >> 2] = (x[i >> 2] || 0) | (0x80 << ((i % 4) * 8));
    const N = (((bitLen + 64) >>> 9) << 4) + 14;
    while (x.length <= N + 1) x.push(0);
    x[N] = bitLen & 0xffffffff; x[N + 1] = Math.floor(bitLen / 0x100000000);

    const add = (a, b) => (a + b) & 0xffffffff;
    const rol = (n, c) => (n << c) | (n >>> (32 - c));
    const cmn = (q, a, b, xk, s, t) => add(rol(add(add(a, q), add(xk, t)), s), b);
    const ff = (a, b, c, d, xk, s, t) => cmn((b & c) | (~b & d), a, b, xk, s, t);
    const gg = (a, b, c, d, xk, s, t) => cmn((b & d) | (c & ~d), a, b, xk, s, t);
    const hh = (a, b, c, d, xk, s, t) => cmn(b ^ c ^ d, a, b, xk, s, t);
    const ii = (a, b, c, d, xk, s, t) => cmn(c ^ (b | ~d), a, b, xk, s, t);

    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (let k = 0; k < x.length; k += 16) {
        const oa = a, ob = b, oc = c, od = d, g = j => x[k + j] | 0;
        a = ff(a,b,c,d,g(0),7,-680876936);   d = ff(d,a,b,c,g(1),12,-389564586);  c = ff(c,d,a,b,g(2),17,606105819);   b = ff(b,c,d,a,g(3),22,-1044525330);
        a = ff(a,b,c,d,g(4),7,-176418897);   d = ff(d,a,b,c,g(5),12,1200080426);  c = ff(c,d,a,b,g(6),17,-1473231341); b = ff(b,c,d,a,g(7),22,-45705983);
        a = ff(a,b,c,d,g(8),7,1770035416);   d = ff(d,a,b,c,g(9),12,-1958414417); c = ff(c,d,a,b,g(10),17,-42063);     b = ff(b,c,d,a,g(11),22,-1990404162);
        a = ff(a,b,c,d,g(12),7,1804603682);  d = ff(d,a,b,c,g(13),12,-40341101);  c = ff(c,d,a,b,g(14),17,-1502002290);b = ff(b,c,d,a,g(15),22,1236535329);
        a = gg(a,b,c,d,g(1),5,-165796510);   d = gg(d,a,b,c,g(6),9,-1069501632);  c = gg(c,d,a,b,g(11),14,643717713);  b = gg(b,c,d,a,g(0),20,-373897302);
        a = gg(a,b,c,d,g(5),5,-701558691);   d = gg(d,a,b,c,g(10),9,38016083);    c = gg(c,d,a,b,g(15),14,-660478335); b = gg(b,c,d,a,g(4),20,-405537848);
        a = gg(a,b,c,d,g(9),5,568446438);    d = gg(d,a,b,c,g(14),9,-1019803690); c = gg(c,d,a,b,g(3),14,-187363961);  b = gg(b,c,d,a,g(8),20,1163531501);
        a = gg(a,b,c,d,g(13),5,-1444681467); d = gg(d,a,b,c,g(2),9,-51403784);    c = gg(c,d,a,b,g(7),14,1735328473);  b = gg(b,c,d,a,g(12),20,-1926607734);
        a = hh(a,b,c,d,g(5),4,-378558);      d = hh(d,a,b,c,g(8),11,-2022574463); c = hh(c,d,a,b,g(11),16,1839030562); b = hh(b,c,d,a,g(14),23,-35309556);
        a = hh(a,b,c,d,g(1),4,-1530992060);  d = hh(d,a,b,c,g(4),11,1272893353);  c = hh(c,d,a,b,g(7),16,-155497632);  b = hh(b,c,d,a,g(10),23,-1094730640);
        a = hh(a,b,c,d,g(13),4,681279174);   d = hh(d,a,b,c,g(0),11,-358537222);  c = hh(c,d,a,b,g(3),16,-722521979);  b = hh(b,c,d,a,g(6),23,76029189);
        a = hh(a,b,c,d,g(9),4,-640364487);   d = hh(d,a,b,c,g(12),11,-421815835); c = hh(c,d,a,b,g(15),16,530742520);  b = hh(b,c,d,a,g(2),23,-995338651);
        a = ii(a,b,c,d,g(0),6,-198630844);   d = ii(d,a,b,c,g(7),10,1126891415);  c = ii(c,d,a,b,g(14),15,-1416354905);b = ii(b,c,d,a,g(5),21,-57434055);
        a = ii(a,b,c,d,g(12),6,1700485571);  d = ii(d,a,b,c,g(3),10,-1894986606); c = ii(c,d,a,b,g(10),15,-1051523);   b = ii(b,c,d,a,g(1),21,-2054922799);
        a = ii(a,b,c,d,g(8),6,1873313359);   d = ii(d,a,b,c,g(15),10,-30611744);  c = ii(c,d,a,b,g(6),15,-1560198380); b = ii(b,c,d,a,g(13),21,1309151649);
        a = ii(a,b,c,d,g(4),6,-145523070);   d = ii(d,a,b,c,g(11),10,-1120210379);c = ii(c,d,a,b,g(2),15,718787259);   b = ii(b,c,d,a,g(9),21,-343485551);
        a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
    }
    const out = [];
    for (const v of [a, b, c, d]) for (let s = 0; s < 32; s += 8) out.push((v >>> s) & 0xff);
    return out;
}
