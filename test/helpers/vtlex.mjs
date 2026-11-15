// An independent reference lexer for the relay filter's tests.
//
// It follows the published DEC ANSI parser description (Paul Williams,
// https://vt100.net/emu/dec_ansi_parser): states, events per byte range, entry
// and exit actions. It is written as data (rule lists) on purpose, so that it
// shares no structure with the C lexer. Where the terminal this relay runs under
// (Ghostty) departs from the description, the departure is stated next to the rule:
//
//   - the ground state decodes UTF-8 first, so C1 bytes are never controls there,
//     and only a decoded ESC leaves it;
//   - ':' is a parameter byte in CSI (SGR sub-parameters);
//   - an OSC string takes every byte from 0x20 to 0xFF, and BEL ends it;
//   - bytes 0xA0-0xFF are ignored in the other string and sequence states;
//   - a CSI with 24 or more parameter separators is dropped, colons are only valid
//     in SGR, and the accumulators saturate.
//
// What it computes, for every position before an input byte and after the last:
// whether the parser is in ground with no UTF-8 sequence open, whether a chunked
// kitty load is open on the active screen, the screen, bracketed paste and the
// foreground colour as the terminal would hold it. The filter's insertions must
// all sit at positions where `isGround` holds.

export const ST = {
  GROUND: 0, ESCAPE: 1, ESC_INT: 2, CSI_ENTRY: 3, CSI_PARAM: 4, CSI_INT: 5, CSI_IGNORE: 6,
  DCS_ENTRY: 7, DCS_PARAM: 8, DCS_INT: 9, DCS_PASS: 10, DCS_IGNORE: 11, OSC: 12, APC: 13,
};
const N_STATES = 14;

// [from state | '*', lo, hi, to state | null (stay), action]
const C0 = (s, action) => [[s, 0x00, 0x17, null, action], [s, 0x19, 0x19, null, action], [s, 0x1c, 0x1f, null, action]];
const RULES = [
  // anywhere
  ['*', 0x18, 0x18, ST.GROUND, 'exec'], ['*', 0x1a, 0x1a, ST.GROUND, 'exec'],
  ['*', 0x80, 0x8f, ST.GROUND, 'exec'], ['*', 0x91, 0x97, ST.GROUND, 'exec'],
  ['*', 0x99, 0x9a, ST.GROUND, 'exec'], ['*', 0x9c, 0x9c, ST.GROUND, 'none'],
  ['*', 0x1b, 0x1b, ST.ESCAPE, 'none'],
  ['*', 0x98, 0x98, ST.APC, 'none'], ['*', 0x9e, 0x9f, ST.APC, 'none'],
  ['*', 0x9b, 0x9b, ST.CSI_ENTRY, 'none'], ['*', 0x90, 0x90, ST.DCS_ENTRY, 'none'],
  ['*', 0x9d, 0x9d, ST.OSC, 'none'],

  // escape
  ...C0(ST.ESCAPE, 'exec'), [ST.ESCAPE, 0x7f, 0x7f, null, 'ignore'],
  [ST.ESCAPE, 0x20, 0x2f, ST.ESC_INT, 'collect'],
  [ST.ESCAPE, 0x30, 0x4f, ST.GROUND, 'esc_dispatch'], [ST.ESCAPE, 0x51, 0x57, ST.GROUND, 'esc_dispatch'],
  [ST.ESCAPE, 0x59, 0x5a, ST.GROUND, 'esc_dispatch'], [ST.ESCAPE, 0x5c, 0x5c, ST.GROUND, 'esc_dispatch'],
  [ST.ESCAPE, 0x60, 0x7e, ST.GROUND, 'esc_dispatch'],
  [ST.ESCAPE, 0x5b, 0x5b, ST.CSI_ENTRY, 'none'], [ST.ESCAPE, 0x5d, 0x5d, ST.OSC, 'none'],
  [ST.ESCAPE, 0x50, 0x50, ST.DCS_ENTRY, 'none'],
  [ST.ESCAPE, 0x58, 0x58, ST.APC, 'none'], [ST.ESCAPE, 0x5e, 0x5f, ST.APC, 'none'],

  // escape intermediate
  ...C0(ST.ESC_INT, 'exec'), [ST.ESC_INT, 0x20, 0x2f, null, 'collect'], [ST.ESC_INT, 0x7f, 0x7f, null, 'ignore'],
  [ST.ESC_INT, 0x30, 0x7e, ST.GROUND, 'esc_dispatch'],

  // CSI entry
  ...C0(ST.CSI_ENTRY, 'exec'), [ST.CSI_ENTRY, 0x7f, 0x7f, null, 'ignore'],
  [ST.CSI_ENTRY, 0x20, 0x2f, ST.CSI_INT, 'collect'], [ST.CSI_ENTRY, 0x3a, 0x3a, ST.CSI_IGNORE, 'none'],
  [ST.CSI_ENTRY, 0x30, 0x39, ST.CSI_PARAM, 'param'], [ST.CSI_ENTRY, 0x3b, 0x3b, ST.CSI_PARAM, 'param'],
  [ST.CSI_ENTRY, 0x3c, 0x3f, ST.CSI_PARAM, 'collect'], [ST.CSI_ENTRY, 0x40, 0x7e, ST.GROUND, 'csi_dispatch'],

  // CSI param (':' is a parameter byte here)
  ...C0(ST.CSI_PARAM, 'exec'), [ST.CSI_PARAM, 0x30, 0x3b, null, 'param'], [ST.CSI_PARAM, 0x7f, 0x7f, null, 'ignore'],
  [ST.CSI_PARAM, 0x3c, 0x3f, ST.CSI_IGNORE, 'none'], [ST.CSI_PARAM, 0x20, 0x2f, ST.CSI_INT, 'collect'],
  [ST.CSI_PARAM, 0x40, 0x7e, ST.GROUND, 'csi_dispatch'],

  // CSI intermediate
  ...C0(ST.CSI_INT, 'exec'), [ST.CSI_INT, 0x20, 0x2f, null, 'collect'], [ST.CSI_INT, 0x7f, 0x7f, null, 'ignore'],
  [ST.CSI_INT, 0x30, 0x3f, ST.CSI_IGNORE, 'none'], [ST.CSI_INT, 0x40, 0x7e, ST.GROUND, 'csi_dispatch'],

  // CSI ignore
  ...C0(ST.CSI_IGNORE, 'exec'), [ST.CSI_IGNORE, 0x20, 0x3f, null, 'ignore'], [ST.CSI_IGNORE, 0x7f, 0x7f, null, 'ignore'],
  [ST.CSI_IGNORE, 0x40, 0x7e, ST.GROUND, 'none'],

  // DCS
  ...C0(ST.DCS_ENTRY, 'ignore'), [ST.DCS_ENTRY, 0x7f, 0x7f, null, 'ignore'],
  [ST.DCS_ENTRY, 0x20, 0x2f, ST.DCS_INT, 'collect'], [ST.DCS_ENTRY, 0x3a, 0x3a, ST.DCS_IGNORE, 'none'],
  [ST.DCS_ENTRY, 0x30, 0x39, ST.DCS_PARAM, 'param'], [ST.DCS_ENTRY, 0x3b, 0x3b, ST.DCS_PARAM, 'param'],
  [ST.DCS_ENTRY, 0x3c, 0x3f, ST.DCS_PARAM, 'collect'], [ST.DCS_ENTRY, 0x40, 0x7e, ST.DCS_PASS, 'none'],
  ...C0(ST.DCS_PARAM, 'ignore'), [ST.DCS_PARAM, 0x30, 0x39, null, 'param'], [ST.DCS_PARAM, 0x3b, 0x3b, null, 'param'],
  [ST.DCS_PARAM, 0x7f, 0x7f, null, 'ignore'], [ST.DCS_PARAM, 0x3a, 0x3a, ST.DCS_IGNORE, 'none'],
  [ST.DCS_PARAM, 0x3c, 0x3f, ST.DCS_IGNORE, 'none'], [ST.DCS_PARAM, 0x20, 0x2f, ST.DCS_INT, 'collect'],
  [ST.DCS_PARAM, 0x40, 0x7e, ST.DCS_PASS, 'none'],
  ...C0(ST.DCS_INT, 'ignore'), [ST.DCS_INT, 0x20, 0x2f, null, 'collect'], [ST.DCS_INT, 0x7f, 0x7f, null, 'ignore'],
  [ST.DCS_INT, 0x30, 0x3f, ST.DCS_IGNORE, 'none'], [ST.DCS_INT, 0x40, 0x7e, ST.DCS_PASS, 'none'],
  ...C0(ST.DCS_IGNORE, 'ignore'),
  ...C0(ST.DCS_PASS, 'put'), [ST.DCS_PASS, 0x20, 0x7e, null, 'put'], [ST.DCS_PASS, 0x7f, 0x7f, null, 'ignore'],

  // OSC: 0x20-0xFF are string bytes (departure), BEL ends the string (xterm)
  ...C0(ST.OSC, 'ignore'),
  [ST.OSC, 0x20, 0xff, null, 'osc_put'], [ST.OSC, 0x07, 0x07, ST.GROUND, 'none'],

  // SOS/PM/APC: the payload is 0x00-0x7F minus CAN, SUB, ESC
  ...C0(ST.APC, 'apc_put'), [ST.APC, 0x20, 0x7f, null, 'apc_put'],
];

// table[state][byte] = [to, action]
const TABLE = Array.from({ length: N_STATES }, (_, s) => Array.from({ length: 256 }, () => [s, 'none']));
for (const [from, lo, hi, to, action] of RULES) {
  for (let s = 0; s < N_STATES; s++) {
    if (from !== '*' && from !== s) continue;
    for (let b = lo; b <= hi; b++) TABLE[s][b] = [to === null ? s : to, action];
  }
}
// ---------------------------------------------------------------------------
// UTF-8 in ground: the WHATWG decoder algorithm. An ill-formed sequence yields
// U+FFFD and the offending byte is looked at again.

class Utf8 {
  constructor() { this.reset(); }
  reset() { this.need = 0; this.seen = 0; this.cp = 0; this.lo = 0x80; this.hi = 0xbf; }
  get idle() { return this.need === 0; }
  // returns an array of code points produced by this byte
  push(b) {
    const out = [];
    for (;;) {
      if (this.need === 0) {
        if (b <= 0x7f) { out.push(b); return out; }
        if (b >= 0xc2 && b <= 0xdf) { this.need = 1; this.cp = b & 0x1f; return out; }
        if (b >= 0xe0 && b <= 0xef) {
          if (b === 0xe0) this.lo = 0xa0;
          if (b === 0xed) this.hi = 0x9f;
          this.need = 2; this.cp = b & 0xf; return out;
        }
        if (b >= 0xf0 && b <= 0xf4) {
          if (b === 0xf0) this.lo = 0x90;
          if (b === 0xf4) this.hi = 0x8f;
          this.need = 3; this.cp = b & 7; return out;
        }
        out.push(0xfffd);
        return out;
      }
      if (b < this.lo || b > this.hi) {
        this.reset();
        out.push(0xfffd);
        continue; // look at the byte again
      }
      this.lo = 0x80; this.hi = 0xbf;
      this.cp = (this.cp << 6) | (b & 0x3f);
      this.seen++;
      if (this.seen === this.need) {
        const cp = this.cp;
        this.reset();
        out.push(cp);
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Kitty graphics command: what decides whether a chunked load is open.

const SAT16 = 0xffff;

// std.fmt.parseInt(u32 or i32, t, 10): an optional sign, '_' between digits, the range of the type.
// The result is the u32 bit pattern that Ghostty stores, or null when Zig returns an error.
function zigParseInt(t, signed) {
  let neg = false;
  let body = t;
  if (body[0] === '+' || body[0] === '-') { neg = body[0] === '-'; body = body.slice(1); }
  if (body === '' || body[0] === '_' || body.endsWith('_')) return null;
  if (!/^[0-9_]+$/.test(body)) return null;
  const v = BigInt(body.replaceAll('_', ''));
  const n = neg ? -v : v;
  const lo = signed ? -(2n ** 31n) : 0n;
  const hi = signed ? 2n ** 31n - 1n : 2n ** 32n - 1n;
  if (n < lo || n > hi) return null;
  return Number(BigInt.asUintN(32, n));
}

class KittyCommand {
  constructor() {
    this.state = 'key'; this.tmp = ''; this.cur = ''; this.kv = new Map();
    this.err = false;
    this.dataLen = 0; this.nonpad = 0; this.pad = 0; this.bad = false;
  }
  store(v) { if ('atmfoqCUiI'.includes(this.cur) && this.cur.length === 1) this.kv.set(this.cur, v); }
  finish() {
    const t = this.tmp;
    this.tmp = '';
    if (t.length === 1 && !(t >= '0' && t <= '9')) { this.store(t.charCodeAt(0)); return; }
    if (t.length === 0) { this.err = true; return; }
    const v = zigParseInt(t, 'zHV'.includes(this.cur));
    if (v === null) { this.err = true; return; }
    this.store(v);
  }
  accum(c, overflow) {
    this.tmp += c;
    if (this.tmp.length > 11) { this.state = overflow; this.tmp = ''; }
  }
  feed(c) {
    switch (this.state) {
      case 'key':
        if (c === '=') {
          if (this.tmp.length !== 1) { this.state = 'valign'; this.tmp = ''; }
          else { this.cur = this.tmp; this.tmp = ''; this.state = 'val'; }
        } else if (c === ';') this.state = 'data';
        else this.accum(c, 'kalign');
        break;
      case 'kalign': if (c === '=') this.state = 'valign'; break;
      case 'val':
        if (c === ',') { this.state = 'key'; this.finish(); }
        else if (c === ';') { this.state = 'data'; this.finish(); }
        else this.accum(c, 'valign');
        break;
      case 'valign':
        if (c === ',') this.state = 'kalign';
        else if (c === ';') this.state = 'data';
        break;
      case 'data': {
        this.dataLen++;
        if (/[A-Za-z0-9+/]/.test(c)) { this.nonpad++; if (this.pad) this.bad = true; }
        else if (c === '=') this.pad = Math.min(this.pad + 1, 3);
        else this.bad = true;
        break;
      }
      default:
    }
  }
  // Returns 'ignore' (no effect), 'close', or 'open' for the load tracked on the active screen,
  // given whether a load is open now. 'keep' leaves it as it is.
  verdict() {
    if (this.state === 'key' || this.state === 'kalign') return 'keep';
    if (this.state === 'val') this.finish();
    if (this.err) return 'keep';
    if (this.dataLen > 65 * 1024 * 1024) return 'keep';
    const kv = this.kv;
    const a = kv.has('a') ? kv.get('a') : 116;
    if (a > 255) return 'keep';
    if (a !== 116 && a !== 84) return 'keep';
    if (kv.has('q') && kv.get('q') > 2) return 'keep';
    if (kv.has('f') && ![24, 32, 100].includes(kv.get('f'))) return 'keep';
    if (kv.has('t') && !'dfts'.split('').map((x) => x.charCodeAt(0)).includes(kv.get('t'))) return 'keep';
    if (kv.has('o') && kv.get('o') !== 122) return 'keep';
    if (a === 84) {
      if (kv.has('C') && kv.get('C') > 1) return 'keep';
      if (kv.has('U') && kv.get('U') > 1) return 'keep';
    }
    if (kv.get('i') > 0 && kv.get('I') > 0) return 'keep';
    const direct = !kv.has('t') || kv.get('t') === 100;
    const more = direct && kv.has('m') && kv.get('m') > 0;
    const certain = !this.bad && this.nonpad % 4 !== 1 &&
      (this.pad === 0 || (this.pad <= 2 && (this.nonpad + this.pad) % 4 === 0));
    if (certain) return more ? 'open' : 'close';
    return more ? 'open' : 'keep';
  }
}

// ---------------------------------------------------------------------------

const clearParams = (p) => { p.inter = []; p.params = []; p.colon = new Set(); p.acc = 0; p.accHas = false; };

// SGR: which foreground colour results. -1 means none (default or palette).
function sgrForeground(params, colon, current) {
  let fg = current;
  const n = params.length;
  if (n === 0) return -1;
  const isColon = (i) => colon.has(i);
  const skipColon = (i) => { // consume a run of colon-joined values starting at i
    let j = i;
    while (j < n - 1 && isColon(j)) j++;
    return j + 1;
  };
  let i = 0;
  while (i < n) {
    const start = i;
    const v = params[i++];
    if (isColon(start) && ![4, 38, 48, 58].includes(v)) {
      while (isColon(i)) i++;
      i++;
      continue;
    }
    if (v === 0 || v === 39 || (v >= 30 && v <= 37) || (v >= 90 && v <= 97)) { fg = -1; continue; }
    if (v === 4) {
      if (isColon(start)) {
        if (n - start < 2) continue;
        if (isColon(i)) i = skipColon(i); else i += 1;
      }
      continue;
    }
    if (v === 38 || v === 48 || v === 58) {
      const rest = n - start;
      if (rest < 2) continue;
      const kind = params[start + 1];
      if (kind === 2 && rest >= 5) {
        let at = -1;
        if (!isColon(start)) { at = start + 2; i += 4; }
        else {
          let cnt = 0;
          for (let j = i; j < n - 1 && isColon(j); j++) cnt++;
          if (cnt === 3) { at = start + 2; i += 4; }
          else if (cnt === 4) { at = start + 3; i += 5; }
          else i += cnt + 1;
        }
        if (at >= 0 && v === 38) fg = ((params[at] & 255) << 16) | ((params[at + 1] & 255) << 8) | (params[at + 2] & 255);
      } else if (kind === 5 && rest >= 3) {
        i += 2;
        if (v === 38) fg = -1;
      }
    }
  }
  return fg;
}

// Runs the reference over a whole buffer. Returns per-position arrays of length n + 1.
export function lex(buf) {
  const n = buf.length;
  const ground = new Uint8Array(n + 1);   // parser in ground and no UTF-8 sequence open
  const state = new Uint8Array(n + 1);    // the parser state (ST), whatever the UTF-8 decoder holds
  const chunk = new Uint8Array(n + 1);    // a chunked load is open on the active screen
  const alt = new Uint8Array(n + 1);
  const tui = new Uint8Array(n + 1);
  const fgs = new Int32Array(n + 1);
  const placeholders = [];                // U+10EEEE decoded in ground: where it ended, with the foreground then

  let st = ST.GROUND;
  const u8 = new Utf8();
  const p = {}; clearParams(p);
  let apc = null; // { kind: 'ident'|'kitty'|'ignore', id, cmd }
  const screen = { cur: 0, fg: [-1, -1], saved: [null, null], chunk: [false, false] };
  let tuiOn = false, lrm = false;
  // value and XTSAVE copy of the modes that do something (Ghostty keeps them apart from the effect)
  const MODES = [47, 1047, 1049, 1048, 2004, 69];
  let mval = new Map(), msaved = new Map();

  const save = () => { screen.saved[screen.cur] = screen.fg[screen.cur]; };
  const restore = () => { const s = screen.saved[screen.cur]; screen.fg[screen.cur] = s === null ? -1 : s; };

  const mode = (m, on) => {
    if (MODES.includes(m)) mval.set(m, on);
    if (m === 2004) tuiOn = on;
    else if (m === 69) lrm = on;
    else if (m === 1048) { if (on) save(); else restore(); }
    else if (m === 47 || m === 1047 || m === 1049) {
      const cur = screen.cur, to = on ? 1 : 0;
      if (m === 1049 && on) save();
      if (to !== cur) {
        screen.cur = to;
        if (m !== 1049 || on) screen.fg[to] = screen.fg[cur];
      }
      if (m === 1049 && !on) restore();
    }
  };

  const csi = (fin) => {
    if (p.params.length >= 24) return;
    if (p.accHas) p.params.push(p.acc);
    if (fin !== 109 && p.colon.size > 0) return;
    const ch = String.fromCharCode(fin);
    if (ch === 'm' && p.inter.length === 0) screen.fg[screen.cur] = sgrForeground(p.params, p.colon, screen.fg[screen.cur]);
    else if ((ch === 'h' || ch === 'l') && p.inter.length === 1 && p.inter[0] === 0x3f) for (const m of p.params) mode(m, ch === 'h');
    else if (ch === 's' && p.inter.length === 0 && p.params.length === 0 && !lrm) save();
    else if (ch === 's' && p.inter.length === 1 && p.inter[0] === 0x3f) {
      for (const m of p.params) if (MODES.includes(m)) msaved.set(m, mval.get(m) ?? false);
    } else if (ch === 'r' && p.inter.length === 1 && p.inter[0] === 0x3f) {
      for (const m of p.params) if (MODES.includes(m)) mode(m, msaved.get(m) ?? false);
    }
    else if (ch === 'u' && p.inter.length === 0) restore();
  };
  const esc = (fin) => {
    if (p.inter.length !== 0) return;
    if (fin === 0x37) save();
    else if (fin === 0x38) restore();
    else if (fin === 0x63) {
      screen.cur = 0; screen.fg = [-1, -1]; screen.saved = [null, null]; screen.chunk = [false, false];
      tuiOn = false; lrm = false; mval = new Map(); msaved = new Map();
    }
  };

  const apcPut = (b) => {
    if (!apc) return;
    if (apc.kind === 'ignore') return;
    const ch = String.fromCharCode(b);
    if (apc.kind === 'ident') {
      if (apc.id.length === 0 && ch === 'G') { apc.kind = 'kitty'; apc.cmd = new KittyCommand(); }
      else if (ch === ';') apc.kind = 'ignore';
      else if (apc.id.length >= 4) apc.kind = 'ignore';
      else apc.id += ch;
    } else apc.cmd.feed(ch);
  };
  const apcEnd = () => {
    const a = apc; apc = null;
    if (!a || a.kind !== 'kitty') return;
    const v = a.cmd.verdict();
    if (v === 'open') screen.chunk[screen.cur] = true;
    else if (v === 'close') screen.chunk[screen.cur] = false;
  };

  const record = (i) => {
    ground[i] = st === ST.GROUND && u8.idle ? 1 : 0;
    state[i] = st;
    chunk[i] = screen.chunk[screen.cur] ? 1 : 0;
    alt[i] = screen.cur;
    tui[i] = tuiOn ? 1 : 0;
    fgs[i] = screen.fg[screen.cur];
  };

  for (let i = 0; i < n; i++) {
    record(i);
    const b = buf[i];
    if (st === ST.GROUND) {
      for (const cp of u8.push(b)) {
        if (cp === 0x1b) { st = ST.ESCAPE; clearParams(p); }
        else if (cp === 0x10eeee) placeholders.push({ end: i + 1, fg: screen.fg[screen.cur] });
      }
      continue;
    }
    const [to, action] = TABLE[st][b];
    if (to !== st && st === ST.APC) apcEnd();
    switch (action) {
      case 'collect': if (p.inter.length < 4) p.inter.push(b); break;
      case 'param':
        if (b === 0x3b || b === 0x3a) {
          if (p.params.length < 24) {
            p.params.push(p.acc);
            if (b === 0x3a) p.colon.add(p.params.length - 1);
            p.acc = 0; p.accHas = false;
          }
        } else { p.acc = Math.min(SAT16, p.acc * 10 + (b - 0x30)); p.accHas = true; }
        break;
      case 'esc_dispatch': esc(b); break;
      case 'csi_dispatch': csi(b); break;
      case 'apc_put': apcPut(b); break;
      default:
    }
    if (to !== st) {
      if (to === ST.ESCAPE || to === ST.CSI_ENTRY || to === ST.DCS_ENTRY) clearParams(p);
      if (to === ST.APC) apc = { kind: 'ident', id: '' };
    }
    st = to;
  }
  record(n);
  return { ground, state, chunk, alt, tui, fg: fgs, placeholders };
}

// A position where an insertion is allowed: ground, nothing half decoded, no open chunked load.
export const isGround = (r, i) => r.ground[i] === 1 && r.chunk[i] === 0;
