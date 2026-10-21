"""Minimal msgpack decoder (arrays, maps, str, int, nil, bool, float) - enough for wordfreq data files."""
import struct

def unpack(b):
    v, i = _d(b, 0)
    return v

def _d(b, i):
    t = b[i]; i += 1
    if t <= 0x7f: return t, i
    if 0x80 <= t <= 0x8f: return _map(b, i, t & 0x0f)
    if 0x90 <= t <= 0x9f: return _arr(b, i, t & 0x0f)
    if 0xa0 <= t <= 0xbf:
        n = t & 0x1f; return b[i:i+n].decode('utf8'), i+n
    if t >= 0xe0: return t - 256, i
    if t == 0xc0: return None, i
    if t == 0xc2: return False, i
    if t == 0xc3: return True, i
    if t == 0xca: return struct.unpack('>f', b[i:i+4])[0], i+4
    if t == 0xcb: return struct.unpack('>d', b[i:i+8])[0], i+8
    ints = {0xcc:'>B',0xcd:'>H',0xce:'>I',0xcf:'>Q',0xd0:'>b',0xd1:'>h',0xd2:'>i',0xd3:'>q'}
    if t in ints:
        f = ints[t]; n = struct.calcsize(f); return struct.unpack(f, b[i:i+n])[0], i+n
    if t in (0xd9,0xda,0xdb):
        k = {0xd9:1,0xda:2,0xdb:4}[t]; n = int.from_bytes(b[i:i+k],'big'); i += k
        return b[i:i+n].decode('utf8'), i+n
    if t in (0xdc,0xdd):
        k = 2 if t==0xdc else 4; n = int.from_bytes(b[i:i+k],'big'); return _arr(b, i+k, n)
    if t in (0xde,0xdf):
        k = 2 if t==0xde else 4; n = int.from_bytes(b[i:i+k],'big'); return _map(b, i+k, n)
    raise ValueError('unsupported msgpack type 0x%x' % t)

def _arr(b, i, n):
    out = []
    for _ in range(n):
        v, i = _d(b, i); out.append(v)
    return out, i

def _map(b, i, n):
    out = {}
    for _ in range(n):
        k, i = _d(b, i); v, i = _d(b, i); out[k] = v
    return out, i
