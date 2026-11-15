/*
 * relay-filter.h: the output filter of the vizpane Codex relay.
 *
 * The relay copies Codex's output to the terminal unchanged, except that this
 * filter inserts kitty graphics APCs at points where the terminal's parser is
 * idle. Two kinds are inserted, and nothing else:
 *   - a transmit (a=T,U=1,t=f) the first time a Unicode placeholder for one of
 *     our images (U+10EEEE, with the image id in a 24-bit foreground colour)
 *     is about to be drawn;
 *   - a delete (a=d,d=I) for every image still loaded on the alternate screen
 *     just before Codex leaves it, and at exit; and for the least recently used
 *     image seen when more than 256 images or 96 MiB are loaded on a screen
 *     (eviction). One ground point can carry
 *     several of these, so nothing here promises "one insertion per point".
 *
 * Why the filter has its own parser. An APC written in the middle of someone
 * else's escape sequence, UTF-8 character or chunked kitty load corrupts that
 * thing. Whether a byte position is safe is decided by the terminal's parser,
 * so the lexer below is a port of Ghostty's (src/terminal/parse_table.zig,
 * Parser.zig, and the ground-state UTF-8 handling of stream.zig; MIT), not an
 * approximation of it. The UTF-8 DFA is Bjoern Hoehrmann's (MIT) as used by
 * Ghostty (src/terminal/UTF8Decoder.zig). Every divergence from "what Ghostty
 * does" is a bug.
 *
 * Parts of this file are derived from Ghostty, Copyright (c) 2024 Mitchell
 * Hashimoto, Ghostty contributors (MIT), and from Bjoern Hoehrmann's decoder,
 * Copyright (c) 2008-2010 Bjoern Hoehrmann (MIT). The permission notices are in
 * LICENSES/ghostty.txt and LICENSES/hoehrmann-utf8-decoder.txt next to this file.
 *
 * Ground point. The lexer is in GROUND, the UTF-8 decoder holds no partial
 * sequence, and no chunked kitty load is open on the active screen. (Ghostty
 * keeps the open load in the per-screen image storage, so the flag is per
 * screen too.) A "chunk open" decision errs towards open: a command the filter
 * cannot prove valid never closes a load.
 *
 * Holdback. A sequence that starts at a ground point is kept in a small buffer
 * until it is complete, so that an insertion can still go in front of it
 * (before the F4 of a placeholder, before ESC of CSI ? 1049 l). Strings (OSC,
 * DCS, APC) are never held. Held bytes are released when the sequence ends,
 * when it grows past VF_HOLD_MAX, on vf_flush and on vf_finish.
 *
 * Where an insertion goes. A transmit goes in front of the placeholder that needs it. When that
 * is not possible (a chunked load is open, or the first byte of the cell is already out because
 * of a flush) it waits in a queue and goes in at the first later ground point that is safe: in
 * front of ESC, of an ASCII byte, of the next placeholder or screen switch, or after any complete
 * sequence. It never goes between a character and the combining marks that may follow it.
 * vf_held() counts one extra "byte" while such a transmit can go out but has not, so that the
 * relay's 5 ms timer lets it out when Codex has gone quiet.
 *
 * The filter reads files (stat, lstat, open, pread) in the session directory
 * and nothing else. It never writes a file, never reads the terminal and never
 * blocks on anything but those lookups. All state has a fixed size; there is no
 * allocation. Every function is total over all byte values.
 *
 * Contract with the caller: out must have room for the input, the bytes held
 * back and VF_SLACK more (cap >= n + VF_SLACK). Insertions check the remaining
 * room themselves and are dropped, never data, if it is not there.
 */
#ifndef VIZPANE_RELAY_FILTER_H
#define VIZPANE_RELAY_FILTER_H

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

/* Most bytes one vf_* call adds beyond its input: at most VF_MAX_TX_PER_CALL
 * transmits (about 420 bytes each) and one delete (about 30 bytes) for each of
 * the at most VF_MAX_LOADED + VF_MAX_TX_PER_CALL images ever loaded. */
#define VF_SLACK 32768
#define VF_HOLD_MAX 64
#define VF_MAX_LOADED 256
#define VF_MAX_ABSENT 64
#define VF_MAX_OPS 64
#define VF_MAX_TX_PER_CALL 32
#define VF_MAX_LOOKUPS_PER_CALL 64   /* file lookups per call: bounds the time a chunk full of unknown ids can take */
#define VF_DIR_MAX 255
#define VF_BUDGET ((uint64_t)96 << 20)
#define VF_PNG_MAX_BYTES ((off_t)32 << 20)
#define VF_PNG_MAX_DIM 10000u
#define VF_ID_MIN 0x100000
#define VF_ID_MAX 0x7FFFFF
#define VF_MAX_PARAMS 24            /* Ghostty's Parser.MAX_PARAMS */
#define VF_APC_MAX ((uint64_t)65 << 20) /* Ghostty's kitty payload limit */
/* Safe cut points (see vf_cuts): at least this far apart, and room for a call's
 * largest output (n + VF_SLACK, 33,792 bytes for the relay's 1,024-byte reads). */
#define VF_CUT_GAP 64
#define VF_MAX_CUTS 1024

/* Lexer states, in the order of Ghostty's Parser.State. The string states
 * come last, so "st >= VF_DCS_ENTRY" means "inside a string". */
enum {
  VF_GROUND, VF_ESCAPE, VF_ESC_INTER, VF_CSI_ENTRY, VF_CSI_INTER, VF_CSI_PARAM,
  VF_CSI_IGNORE, VF_DCS_ENTRY, VF_DCS_PARAM, VF_DCS_INTER, VF_DCS_PASS,
  VF_DCS_IGNORE, VF_OSC, VF_APC
};

enum { VF_PRIMARY = 0, VF_ALT = 1 };
enum { VF_OP_TX = 1, VF_OP_DEL = 2 };
enum { VF_FG_NONE = -1 };

/* Kitty control keys the filter looks at. */
enum { VK_A, VK_T, VK_M, VK_F, VK_O, VK_Q, VK_C, VK_U, VK_I, VK_NUM, VK_COUNT };
/* APC kinds, decided by the first byte(s) like Ghostty's apc.Handler. */
enum { VA_NONE, VA_IDENT, VA_KITTY, VA_IGNORE };
/* kitty CommandParser states. */
enum { KP_KEY, KP_KEY_IGN, KP_VAL, KP_VAL_IGN, KP_DATA };

typedef struct {
  uint32_t v;
  uint8_t has;
} vf_kv_t;

typedef struct {
  uint32_t id;
  uint32_t bytes;       /* decoded size, w * h * 4 */
  uint64_t seq;         /* last sighting, for LRU */
} vf_loaded_t;

typedef struct {
  uint32_t id;
  uint8_t kind;
  uint8_t c, r;
  uint8_t deferred;     /* counted as deferred already */
  uint32_t bytes;       /* an eviction: the victim's size, to put it back if the delete is dropped */
  uint64_t trig_in;     /* input offset of the placeholder that queued it */
} vf_op_t;

typedef struct {
  uint64_t triggers;        /* placeholders that needed a transmit */
  uint64_t transmits;       /* transmits inserted */
  uint64_t deletes_leave;   /* deletes inserted before leaving a screen */
  uint64_t deletes_lru;     /* deletes inserted to stay in budget */
  uint64_t deletes_finish;  /* deletes inserted at exit */
  uint64_t deferred;        /* transmits that could not go in at their natural point */
  uint64_t deferred_chunk;  /*   ... because a chunked load was open */
  uint64_t deferred_unheld; /*   ... because the placeholder's first byte had already been let out */
  uint64_t defer_bytes_sum; /* input bytes between trigger and insertion, over all transmits */
  uint64_t defer_bytes_max;
  uint64_t absent_added;
  uint64_t dropped_no_room; /* insertions dropped for lack of output room */
  uint64_t dropped_data;    /* data bytes that did not fit: the caller broke the cap contract */
  uint64_t hold_overflow;   /* sequences longer than VF_HOLD_MAX */
  uint64_t leave_skipped;   /* leaves that could not free (not a ground point) */
} vf_stats_t;

#ifdef VF_LOG
typedef struct {
  uint64_t in_off, out_off;
  uint32_t len, id;
  char kind;
} vf_logent_t;
#define VF_LOG_MAX 1024
#endif

typedef struct vf vf_t;
struct vf {
  /* configuration */
  char dir[VF_DIR_MAX + 1];
  uint16_t dir_len;
  uint8_t enabled;
  uid_t uid;

  /* lexer */
  uint8_t st;
  uint8_t u_state;                  /* UTF-8 DFA state, 0 = idle */
  uint32_t u_acc;
  uint8_t ni;                       /* intermediates collected, at most 4 */
  uint8_t inter[4];
  uint8_t np;                       /* parameters stored, at most VF_MAX_PARAMS */
  uint16_t params[VF_MAX_PARAMS];
  uint32_t colon;                   /* bit n: colon after parameter n */
  uint16_t acc;
  uint8_t acc_has;

  /* APC */
  uint8_t apc, id_len, id_buf[4];
  uint8_t kp, kv_len, kv_tmp[11], kv_cur, kv_err;
  vf_kv_t kv[VK_COUNT];
  uint64_t d_len, d_nonpad;
  uint8_t d_pad, d_bad;

  /* what the terminal believes (per screen where the terminal keeps it per screen) */
  int32_t fg[2], saved_fg[2];
  uint8_t has_saved[2];
  uint8_t screen;
  uint8_t chunk[2];
  uint8_t tui;
  uint8_t lrm;                      /* DEC mode 69: decides what CSI s means */
  uint8_t mval[6], msaved[6];       /* values and XTSAVE copies of the modes in vf_mode_slot */
  uint8_t after_seq;                /* the last thing consumed was a sequence, not text */

  /* holdback */
  uint8_t holding, hn;
  uint8_t hold[VF_HOLD_MAX];
  uint64_t hold_in;                 /* input offset of hold[0] */
  uint8_t ins_screen;               /* screen at the start of the held region */
  uint8_t ev_switch, ev_leave;
  uint8_t finished;

  /* safe cut points of the current call, as offsets into its output */
  uint32_t cut[VF_MAX_CUTS];
  uint16_t ncut;
  uint32_t cut_cand;                /* latest point not recorded yet: it is recorded if the next one is too far */
  uint8_t has_cand;

  /* loaded images */
  vf_loaded_t loaded[2][VF_MAX_LOADED];
  uint16_t n_loaded[2];
  uint64_t sum_loaded[2];
  uint64_t clock;
  uint32_t mru_id;                  /* one-entry cache for runs of the same id */
  int mru_idx;
  uint8_t mru_screen;

  /* ids with no usable files */
  uint32_t absent[VF_MAX_ABSENT];
  uint8_t n_absent, absent_next;
  int64_t mt_sec;
  int64_t mt_nsec;
  uint8_t dir_checked;

  /* queued insertions, in order */
  vf_op_t q[VF_MAX_OPS];
  uint8_t nq;
  uint8_t op_screen;
  uint8_t tx_call;
  uint8_t lookups;

  /* counters */
  uint64_t in_base;                 /* input bytes before this call */
  uint64_t out_base;                /* output bytes before this call */
  uint32_t transmits;
  vf_stats_t stats;
#ifdef VF_LOG
  vf_logent_t log[VF_LOG_MAX];
  uint16_t log_n;
  uint8_t log_over;
#endif
};

typedef struct {
  unsigned char *out;
  size_t cap;
  size_t o;
  size_t ub;                        /* data bytes still to be written, upper bound */
  size_t in_n;                      /* length of the input of this call */
  size_t lost;                      /* data bytes that did not fit */
} vf_io;

/* ------------------------------------------------------------------------ */
/* UTF-8 */

static const uint8_t vf_u8_class[256] = {
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  8, 8, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  10, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 3, 3, 11, 6, 6, 6, 5, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
};

static const uint8_t vf_u8_tr[108] = {
  0, 12, 24, 36, 60, 96, 84, 12, 12, 12, 48, 72,
  12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12,
  12, 0, 12, 12, 12, 12, 12, 0, 12, 0, 12, 12,
  12, 24, 12, 12, 12, 12, 12, 24, 12, 24, 12, 12,
  12, 12, 12, 12, 12, 12, 12, 24, 12, 12, 12, 12,
  12, 24, 12, 12, 12, 12, 12, 12, 12, 24, 12, 12,
  12, 12, 12, 12, 12, 12, 12, 36, 12, 36, 12, 12,
  12, 36, 12, 12, 12, 12, 12, 36, 12, 36, 12, 12,
  12, 36, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12,
};

/* One byte through the decoder. Returns 1 when *cp is valid. *consumed is 0 only
 * when an ill-formed sequence ended before this byte: the caller feeds the byte
 * again. This is Ghostty's UTF8Decoder.next. */
static int vf_u8_next(vf_t *f, unsigned char b, uint32_t *cp, int *consumed) {
  unsigned cls = vf_u8_class[b];
  unsigned init = f->u_state;
  if (init != 0) f->u_acc = (f->u_acc << 6) | (b & 0x3Fu);
  else f->u_acc = (0xFFu >> cls) & b;
  f->u_state = vf_u8_tr[f->u_state + cls];
  if (f->u_state == 0) {
    *cp = f->u_acc;
    f->u_acc = 0;
    *consumed = 1;
    return 1;
  }
  if (f->u_state == 12) {
    f->u_acc = 0;
    f->u_state = 0;
    *cp = 0xFFFD;
    *consumed = init == 0;
    return 1;
  }
  *consumed = 1;
  return 0;
}

/* ------------------------------------------------------------------------ */
/* Small helpers */

static size_t vf_u32(unsigned char *d, uint32_t v) {
  unsigned char t[10];
  size_t n = 0, i;
  do { t[n++] = (unsigned char)('0' + v % 10); v /= 10; } while (v);
  for (i = 0; i < n; i++) d[i] = t[n - 1 - i];
  return n;
}

static size_t vf_b64(unsigned char *d, const unsigned char *s, size_t n) {
  static const char a[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t i = 0, o = 0;
  while (i + 3 <= n) {
    uint32_t v = ((uint32_t)s[i] << 16) | ((uint32_t)s[i + 1] << 8) | s[i + 2];
    d[o++] = (unsigned char)a[v >> 18]; d[o++] = (unsigned char)a[(v >> 12) & 63];
    d[o++] = (unsigned char)a[(v >> 6) & 63]; d[o++] = (unsigned char)a[v & 63];
    i += 3;
  }
  if (n - i == 1) {
    uint32_t v = (uint32_t)s[i] << 16;
    d[o++] = (unsigned char)a[v >> 18]; d[o++] = (unsigned char)a[(v >> 12) & 63];
    d[o++] = '='; d[o++] = '=';
  } else if (n - i == 2) {
    uint32_t v = ((uint32_t)s[i] << 16) | ((uint32_t)s[i + 1] << 8);
    d[o++] = (unsigned char)a[v >> 18]; d[o++] = (unsigned char)a[(v >> 12) & 63];
    d[o++] = (unsigned char)a[(v >> 6) & 63]; d[o++] = '=';
  }
  return o;
}

static void vf_hex6(unsigned char *d, uint32_t id) {
  static const char h[] = "0123456789abcdef";
  int i;
  for (i = 0; i < 6; i++) d[i] = (unsigned char)h[(id >> (20 - 4 * i)) & 15];
}

/* ------------------------------------------------------------------------ */
/* Output and insertion log */

static void vf_put(vf_io *io, const unsigned char *p, size_t n) {
  size_t room = io->cap - io->o;
  if (n > room) { io->lost += n - room; n = room; } /* cannot happen when the caller keeps the contract */
  if (n) memcpy(io->out + io->o, p, n);
  io->o += n;
}

/* Safe cut points. The relay writes to the terminal in pieces, and a piece may end
 * only where another writer's bytes can land without cutting a sequence or a
 * character in two, nor a character from the combining marks that follow it: at a
 * ground point (parser in ground, no partial UTF-8) where the next byte is below
 * 0x80 or the previous item was a complete sequence. That is the rule vf_boundary
 * uses for insertions. The points are recorded as offsets into the output of the
 * current call, at least VF_CUT_GAP apart, except that the last one of the call is
 * always there: a point that would be skipped is kept as a candidate and recorded
 * when the next point is more than VF_CUT_GAP away or the call ends, so
 * consecutive points are never further apart than VF_CUT_GAP where the stream has
 * enough of them. When the array is full the last entry is replaced, so the end of
 * the call is still covered. */
static void vf_cut_add(vf_t *f, uint32_t o) {
  if (f->ncut < VF_MAX_CUTS) f->cut[f->ncut++] = o;
  else f->cut[VF_MAX_CUTS - 1] = o;
}

static void vf_cut(vf_t *f, size_t o) {
  uint32_t last = f->ncut ? f->cut[f->ncut - 1] : 0;
  if (f->ncut && o <= last) return;
  if (f->ncut && o - last > VF_CUT_GAP && f->has_cand) {
    vf_cut_add(f, f->cut_cand);
    last = f->cut_cand;
    f->has_cand = 0;
  }
  if (f->ncut == 0 || o - last >= VF_CUT_GAP) {
    vf_cut_add(f, (uint32_t)o);
    f->has_cand = 0;
  } else {
    f->cut_cand = (uint32_t)o;
    f->has_cand = 1;
  }
}

static void vf_cuts_begin(vf_t *f) {
  f->ncut = 0;
  f->has_cand = 0;
}

static void vf_cuts_end(vf_t *f) {
  if (f->has_cand) vf_cut_add(f, f->cut_cand);
  f->has_cand = 0;
}

static int vf_room(const vf_io *io, size_t len) {
  /* The held bytes (at most VF_HOLD_MAX) and the unread input must still fit. */
  return io->o + len + io->ub + VF_HOLD_MAX <= io->cap;
}

/* Writes one inserted APC, if there is room. */
static int vf_insert(vf_t *f, vf_io *io, const unsigned char *p, size_t n, char kind, uint32_t id,
                     uint64_t at_in) {
  if (!vf_room(io, n)) {
    f->stats.dropped_no_room++;
    return 0;
  }
#ifdef VF_LOG
  if (f->log_n < VF_LOG_MAX) {
    vf_logent_t *e = &f->log[f->log_n++];
    e->in_off = at_in;
    e->out_off = f->out_base + io->o;
    e->len = (uint32_t)n;
    e->id = id;
    e->kind = kind;
  } else {
    f->log_over = 1;
  }
#else
  (void)kind; (void)id; (void)at_in;
#endif
  /* An insertion sits at a ground point, so the point in front of it is safe (what follows is
   * ESC), and so is the one after it (an inserted sequence is complete). */
  vf_cut(f, io->o);
  vf_put(io, p, n);
  vf_cut(f, io->o);
  return 1;
}

static size_t vf_build_del(unsigned char *b, uint32_t id) {
  static const char pre[] = "\x1b_Ga=d,d=I,i=";
  static const char post[] = ",q=2\x1b\\";
  size_t n = 0;
  memcpy(b, pre, sizeof(pre) - 1); n += sizeof(pre) - 1;
  n += vf_u32(b + n, id);
  memcpy(b + n, post, sizeof(post) - 1); n += sizeof(post) - 1;
  return n;
}

static size_t vf_build_tx(const vf_t *f, unsigned char *b, uint32_t id, unsigned c, unsigned r) {
  static const char pre[] = "\x1b_Ga=T,U=1,f=100,t=f,q=2,C=1,i=";
  unsigned char path[VF_DIR_MAX + 12];
  size_t n = 0, pl = 0;
  memcpy(b, pre, sizeof(pre) - 1); n += sizeof(pre) - 1;
  n += vf_u32(b + n, id);
  memcpy(b + n, ",c=", 3); n += 3;
  n += vf_u32(b + n, c);
  memcpy(b + n, ",r=", 3); n += 3;
  n += vf_u32(b + n, r);
  b[n++] = ';';
  memcpy(path, f->dir, f->dir_len); pl = f->dir_len;
  path[pl++] = '/';
  vf_hex6(path + pl, id); pl += 6;
  memcpy(path + pl, ".png", 4); pl += 4;
  n += vf_b64(b + n, path, pl);
  b[n++] = 0x1b; b[n++] = '\\';
  return n;
}

/* ------------------------------------------------------------------------ */
/* Loaded images, absent ids, validation */

static int vf_find_loaded(vf_t *f, unsigned s, uint32_t id) {
  unsigned i;
  if (f->mru_screen == s && f->mru_id == id && f->mru_idx >= 0 && f->mru_idx < f->n_loaded[s] &&
      f->loaded[s][f->mru_idx].id == id)
    return f->mru_idx;
  for (i = 0; i < f->n_loaded[s]; i++) {
    if (f->loaded[s][i].id == id) {
      f->mru_screen = (uint8_t)s; f->mru_id = id; f->mru_idx = (int)i;
      return (int)i;
    }
  }
  return -1;
}

static void vf_remove_loaded(vf_t *f, unsigned s, unsigned idx) {
  f->sum_loaded[s] -= f->loaded[s][idx].bytes;
  f->n_loaded[s]--;
  if (idx != f->n_loaded[s]) f->loaded[s][idx] = f->loaded[s][f->n_loaded[s]];
  f->mru_idx = -1;
}

static void vf_clear_loaded(vf_t *f, unsigned s) {
  f->n_loaded[s] = 0;
  f->sum_loaded[s] = 0;
  f->mru_idx = -1;
}

static int vf_absent_has(const vf_t *f, uint32_t id) {
  unsigned i;
  for (i = 0; i < f->n_absent; i++) if (f->absent[i] == id) return 1;
  return 0;
}

static void vf_absent_add(vf_t *f, uint32_t id) {
  if (f->n_absent < VF_MAX_ABSENT) {
    f->absent[f->n_absent++] = id;
  } else {
    f->absent[f->absent_next] = id;
    f->absent_next = (uint8_t)((f->absent_next + 1) % VF_MAX_ABSENT);
  }
  f->stats.absent_added++;
}

static void vf_absent_clear(vf_t *f) {
  f->n_absent = 0;
  f->absent_next = 0;
}

static int vf_dir_mtime(const vf_t *f, int64_t *sec, int64_t *nsec) {
  struct stat st;
  if (stat(f->dir, &st) != 0) return -1;
#if defined(__APPLE__)
  *sec = (int64_t)st.st_mtimespec.tv_sec; *nsec = (int64_t)st.st_mtimespec.tv_nsec;
#else
  *sec = (int64_t)st.st_mtim.tv_sec; *nsec = (int64_t)st.st_mtim.tv_nsec;
#endif
  return 0;
}

/* Reads up to cap bytes of a regular file that we own, without following a
 * symlink, and reports its size. Returns -1 when the file is not acceptable. */
static int vf_read_file(const vf_t *f, const unsigned char *name, size_t name_len, off_t max_size,
                        unsigned char *buf, size_t want, size_t *got, off_t *size_out) {
  char path[VF_DIR_MAX + 16];
  struct stat a, b;
  int fd;
  size_t have = 0;
  if ((size_t)f->dir_len + 1 + name_len + 1 > sizeof(path)) return -1;
  memcpy(path, f->dir, f->dir_len);
  path[f->dir_len] = '/';
  memcpy(path + f->dir_len + 1, name, name_len);
  path[f->dir_len + 1 + name_len] = 0;
  if (lstat(path, &a) != 0) return -1;
  if (!S_ISREG(a.st_mode) || a.st_uid != f->uid || a.st_size > max_size) return -1;
  fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return -1;
  if (fstat(fd, &b) != 0 || !S_ISREG(b.st_mode) || b.st_uid != f->uid || b.st_dev != a.st_dev ||
      b.st_ino != a.st_ino || b.st_size > max_size) {
    close(fd);
    return -1;
  }
  while (have < want) {
    ssize_t r = pread(fd, buf + have, want - have, (off_t)have);
    if (r < 0) {
      if (errno == EINTR) continue;
      close(fd);
      return -1;
    }
    if (r == 0) break;
    have += (size_t)r;
  }
  close(fd);
  *got = have;
  *size_out = b.st_size;
  return 0;
}

/* Checks <id>.png and <id>.cr. On success returns 0 and the decoded size and
 * the cell box. */
static int vf_probe(const vf_t *f, uint32_t id, uint64_t *bytes, unsigned *c, unsigned *r) {
  unsigned char name[16], b[40];
  size_t got = 0, i;
  off_t size = 0;
  uint32_t w, h;
  unsigned v[2] = {0, 0};
  unsigned k = 0;

  vf_hex6(name, id);
  memcpy(name + 6, ".png", 4);
  if (vf_read_file(f, name, 10, VF_PNG_MAX_BYTES, b, 33, &got, &size) != 0) return -1;
  if (got < 33 || size < 33) return -1;
  {
    static const unsigned char sig[8] = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
    if (memcmp(b, sig, 8) != 0) return -1;
    if (b[8] != 0 || b[9] != 0 || b[10] != 0 || b[11] != 13) return -1;
    if (memcmp(b + 12, "IHDR", 4) != 0) return -1;
    w = ((uint32_t)b[16] << 24) | ((uint32_t)b[17] << 16) | ((uint32_t)b[18] << 8) | b[19];
    h = ((uint32_t)b[20] << 24) | ((uint32_t)b[21] << 16) | ((uint32_t)b[22] << 8) | b[23];
    if (w < 1 || h < 1 || w > VF_PNG_MAX_DIM || h > VF_PNG_MAX_DIM) return -1;
  }
  memcpy(name + 6, ".cr", 3);
  if (vf_read_file(f, name, 9, 32, b, 32, &got, &size) != 0) return -1;
  if (got != (size_t)size || got < 3 || got > 8) return -1;
  /* "C R" with one space, a newline allowed at the end, each 1..255 */
  i = 0;
  for (k = 0; k < 2; k++) {
    unsigned digits = 0;
    unsigned val = 0;
    while (i < got && b[i] >= '0' && b[i] <= '9') {
      val = val * 10 + (unsigned)(b[i] - '0');
      if (++digits > 3) return -1;
      i++;
    }
    if (digits == 0 || val < 1 || val > 255) return -1;
    v[k] = val;
    if (k == 0) {
      if (i >= got || b[i] != ' ') return -1;
      i++;
    }
  }
  if (i < got && b[i] == '\n') i++;
  if (i != got) return -1;
  *bytes = (uint64_t)w * h * 4;
  if (*bytes > VF_BUDGET) return -1;
  *c = v[0];
  *r = v[1];
  return 0;
}

/* ------------------------------------------------------------------------ */
/* Queued insertions */

static int vf_q_has_tx(const vf_t *f, uint32_t id) {
  unsigned i;
  for (i = 0; i < f->nq; i++) if (f->q[i].kind == VF_OP_TX && f->q[i].id == id) return 1;
  return 0;
}

/* Gives up the whole queue. A transmit that never went out is not loaded. An
 * eviction that never went out leaves its victim in the terminal's storage, so
 * the victim goes back on the list of loaded images and the next leave or
 * finish on that screen deletes it. */
static void vf_q_drop_all(vf_t *f) {
  unsigned i, s = f->op_screen;
  for (i = 0; i < f->nq; i++) {
    if (f->q[i].kind == VF_OP_TX) {
      int idx = vf_find_loaded(f, s, f->q[i].id);
      if (idx >= 0) vf_remove_loaded(f, s, (unsigned)idx);
    }
  }
  for (i = 0; i < f->nq; i++) {
    if (f->q[i].kind == VF_OP_DEL && f->n_loaded[s] < VF_MAX_LOADED &&
        vf_find_loaded(f, s, f->q[i].id) < 0) {
      vf_loaded_t *l = &f->loaded[s][f->n_loaded[s]++];
      l->id = f->q[i].id;
      l->bytes = f->q[i].bytes;
      l->seq = 0;
      f->sum_loaded[s] += l->bytes;
    }
  }
  f->mru_idx = -1;
  f->nq = 0;
}

/* Forgets the transmits that never went out; evictions stay queued. */
static void vf_q_drop_tx(vf_t *f) {
  unsigned i, keep = 0;
  for (i = 0; i < f->nq; i++) {
    if (f->q[i].kind == VF_OP_TX) {
      int idx = vf_find_loaded(f, f->op_screen, f->q[i].id);
      if (idx >= 0) vf_remove_loaded(f, f->op_screen, (unsigned)idx);
    } else {
      f->q[keep++] = f->q[i];
    }
  }
  f->nq = (uint8_t)keep;
}

static void vf_q_push(vf_t *f, uint8_t kind, uint32_t id, unsigned c, unsigned r, uint64_t trig) {
  vf_op_t *o = &f->q[f->nq++];
  o->kind = kind;
  o->id = id;
  o->c = (uint8_t)c;
  o->r = (uint8_t)r;
  o->deferred = 0;
  o->trig_in = trig;
}

/* Emits queued operations in order while there is room. at_in is the input
 * offset the insertion sits in front of. */
static void vf_q_emit(vf_t *f, vf_io *io, uint64_t at_in) {
  unsigned done = 0;
  unsigned char b[512];
  while (done < f->nq) {
    vf_op_t *o = &f->q[done];
    size_t n;
    if (o->kind == VF_OP_TX) n = vf_build_tx(f, b, o->id, o->c, o->r);
    else n = vf_build_del(b, o->id);
    if (!vf_insert(f, io, b, n, o->kind == VF_OP_TX ? 'T' : 'D', o->id, at_in)) break;
    if (o->kind == VF_OP_TX) {
      uint64_t d = at_in > o->trig_in ? at_in - o->trig_in : 0;
      f->transmits++;
      f->stats.transmits++;
      if (o->deferred) {
        f->stats.defer_bytes_sum += d;
        if (d > f->stats.defer_bytes_max) f->stats.defer_bytes_max = d;
      }
    } else {
      f->stats.deletes_lru++;
    }
    done++;
  }
  if (done) {
    memmove(f->q, f->q + done, (f->nq - done) * sizeof(f->q[0]));
    f->nq = (uint8_t)(f->nq - done);
  }
}

static void vf_q_mark_deferred(vf_t *f, int chunk) {
  unsigned i;
  for (i = 0; i < f->nq; i++) {
    if (f->q[i].kind == VF_OP_TX && !f->q[i].deferred) {
      f->q[i].deferred = 1;
      f->stats.deferred++;
      if (chunk) f->stats.deferred_chunk++;
      else f->stats.deferred_unheld++;
    }
  }
}

/* A placeholder is about to be drawn with foreground fg. Queues what the
 * terminal needs before it can draw the picture. */
static void vf_trigger(vf_t *f, uint64_t at_in) {
  int32_t fg = f->fg[f->screen];
  uint32_t id;
  unsigned s = f->screen;
  uint64_t bytes = 0;
  unsigned c = 0, r = 0;
  int64_t sec = 0, nsec = 0;
  int have_mt;
  int idx;

  if (!f->enabled || fg < VF_ID_MIN || fg > VF_ID_MAX) return;
  id = (uint32_t)fg;
  idx = vf_find_loaded(f, s, id);
  if (idx >= 0) {
    f->loaded[s][idx].seq = ++f->clock;
    return;
  }
  if (f->n_absent && vf_absent_has(f, id)) {
    if (!f->dir_checked) {
      f->dir_checked = 1;
      if (vf_dir_mtime(f, &sec, &nsec) == 0 && (sec != f->mt_sec || nsec != f->mt_nsec)) vf_absent_clear(f);
    }
    if (vf_absent_has(f, id)) return;
  }
  if (f->tx_call >= VF_MAX_TX_PER_CALL || f->lookups >= VF_MAX_LOOKUPS_PER_CALL) return;
  f->lookups++;
  /* The snapshot goes first: a file that appears after it changes the mtime. */
  have_mt = vf_dir_mtime(f, &sec, &nsec) == 0;
  if (vf_probe(f, id, &bytes, &c, &r) != 0) {
    if (f->n_absent == 0 && have_mt) { f->mt_sec = sec; f->mt_nsec = nsec; }
    vf_absent_add(f, id);
    return;
  }
  /* Make room: evict least recently seen images until the new one fits. */
  {
    unsigned need_ops = 1;
    unsigned evict = 0;
    uint64_t sum = f->sum_loaded[s];
    unsigned count = f->n_loaded[s];
    unsigned char taken[VF_MAX_LOADED];
    unsigned victims[VF_MAX_OPS];
    memset(taken, 0, sizeof(taken));
    while (sum + bytes > VF_BUDGET || count >= VF_MAX_LOADED) {
      unsigned best = VF_MAX_LOADED, i;
      for (i = 0; i < f->n_loaded[s]; i++) {
        if (taken[i]) continue;
        if (vf_q_has_tx(f, f->loaded[s][i].id)) continue; /* not out yet: nothing to delete */
        if (best == VF_MAX_LOADED || f->loaded[s][i].seq < f->loaded[s][best].seq) best = i;
      }
      if (best == VF_MAX_LOADED || evict >= VF_MAX_OPS) return;
      taken[best] = 1;
      victims[evict++] = best;
      sum -= f->loaded[s][best].bytes;
      count--;
    }
    need_ops += evict;
    if (f->nq + need_ops > VF_MAX_OPS) return;
    if (f->nq == 0) f->op_screen = (uint8_t)s;
    if (f->nq != 0 && f->op_screen != s) return;
    {
      /* Remove from the highest index down so swaps do not move a victim. */
      unsigned a, b2;
      for (a = 0; a < evict; a++)
        for (b2 = a + 1; b2 < evict; b2++)
          if (victims[b2] > victims[a]) { unsigned t = victims[a]; victims[a] = victims[b2]; victims[b2] = t; }
      for (a = 0; a < evict; a++) {
        vf_q_push(f, VF_OP_DEL, f->loaded[s][victims[a]].id, 0, 0, at_in);
        f->q[f->nq - 1].bytes = f->loaded[s][victims[a]].bytes;
        vf_remove_loaded(f, s, victims[a]);
      }
    }
  }
  vf_q_push(f, VF_OP_TX, id, c, r, at_in);
  f->loaded[s][f->n_loaded[s]].id = id;
  f->loaded[s][f->n_loaded[s]].bytes = (uint32_t)bytes;
  f->loaded[s][f->n_loaded[s]].seq = ++f->clock;
  f->n_loaded[s]++;
  f->sum_loaded[s] += bytes;
  f->mru_idx = -1;
  f->tx_call++;
  f->stats.triggers++;
}

/* Deletes every image loaded on screen s, in the order they were loaded. Images
 * that did not fit in the output stay loaded. */
static void vf_free_screen(vf_t *f, vf_io *io, unsigned s, uint64_t at_in, uint64_t *counter) {
  unsigned char b[64];
  unsigned i, n = 0;
  uint64_t sum = 0;
  if (f->nq && f->op_screen == s) {
    /* a transmit still waiting is not loaded, so there is nothing to free for it;
     * the evictions queued before it are still due */
    vf_q_drop_tx(f);
    vf_q_emit(f, io, at_in);
  }
  for (i = 0; i < f->n_loaded[s]; i++) {
    size_t len = vf_build_del(b, f->loaded[s][i].id);
    if (!vf_insert(f, io, b, len, 'D', f->loaded[s][i].id, at_in)) break;
    (*counter)++;
    n++;
  }
  if (n) memmove(f->loaded[s], f->loaded[s] + n, (f->n_loaded[s] - n) * sizeof(f->loaded[s][0]));
  f->n_loaded[s] = (uint16_t)(f->n_loaded[s] - n);
  for (i = 0; i < f->n_loaded[s]; i++) sum += f->loaded[s][i].bytes;
  f->sum_loaded[s] = sum;
  f->mru_idx = -1;
}

/* ------------------------------------------------------------------------ */
/* Cursor and SGR state */

static void vf_save_cursor(vf_t *f) {
  f->saved_fg[f->screen] = f->fg[f->screen];
  f->has_saved[f->screen] = 1;
}

static void vf_restore_cursor(vf_t *f) {
  f->fg[f->screen] = f->has_saved[f->screen] ? f->saved_fg[f->screen] : VF_FG_NONE;
}

static int vf_colon_at(const vf_t *f, size_t i) {
  return i < VF_MAX_PARAMS && ((f->colon >> i) & 1u);
}

/* Ghostty's sgr.Parser, reduced to what decides the foreground colour. Note the
 * malformed forms: a short 38;2 or 38;5 consumes only the 38 and the following
 * parameters are read as if they stood alone. */
static void vf_sgr(vf_t *f) {
  const uint16_t *p = f->params;
  size_t len = f->np, idx = 0;
  int32_t *fg = &f->fg[f->screen];

  if (len == 0) { *fg = VF_FG_NONE; return; }
  while (idx < len) {
    size_t base = idx, rem = len - base;
    int colon = vf_colon_at(f, idx);
    uint16_t v = p[idx];
    idx++;
    if (colon && !(v == 4 || v == 38 || v == 48 || v == 58)) {
      while (vf_colon_at(f, idx)) idx++;
      idx++;
      continue;
    }
    switch (v) {
    case 0: case 39:
      *fg = VF_FG_NONE;
      break;
    case 4:
      if (colon) {
        if (rem < 2) break;
        if (vf_colon_at(f, idx)) {
          size_t cnt = 0, j = idx;
          while (j < len - 1 && vf_colon_at(f, j)) { cnt++; j++; }
          idx += cnt + 1;
        } else {
          idx += 1;
        }
      }
      break;
    case 38: case 48: case 58:
      if (rem >= 2) {
        if (p[base + 1] == 2) {
          if (rem >= 5) {
            int ok = 1;
            size_t off = 0;
            if (!colon) {
              off = 2;
              idx += 4;
            } else {
              size_t cnt = 0, j = idx;
              while (j < len - 1 && vf_colon_at(f, j)) { cnt++; j++; }
              if (cnt == 3) { off = 2; idx += 4; }
              else if (cnt == 4) { off = 3; idx += 5; }
              else { idx += cnt + 1; ok = 0; }
            }
            if (ok && v == 38) {
              *fg = (int32_t)(((uint32_t)(uint8_t)p[base + off] << 16) |
                              ((uint32_t)(uint8_t)p[base + off + 1] << 8) |
                              (uint32_t)(uint8_t)p[base + off + 2]);
            }
          }
        } else if (p[base + 1] == 5) {
          if (rem >= 3) {
            idx += 2;
            if (v == 38) *fg = VF_FG_NONE;
          }
        }
      }
      break;
    default:
      if ((v >= 30 && v <= 37) || (v >= 90 && v <= 97)) *fg = VF_FG_NONE;
      break;
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Screens and modes */

/* The modes the filter acts on. Ghostty keeps a value and an XTSAVE copy for
 * each mode separately from what the mode does, so a restore re-runs the mode's
 * effect even when the value did not change. */
static int vf_mode_slot(unsigned mode) {
  switch (mode) {
  case 47: return 0;
  case 1047: return 1;
  case 1049: return 2;
  case 1048: return 3;
  case 2004: return 4;
  case 69: return 5;
  default: return -1;
  }
}

static void vf_mode(vf_t *f, unsigned mode, int enable) {
  int slot = vf_mode_slot(mode);
  if (slot >= 0) f->mval[slot] = enable ? 1 : 0;
  switch (mode) {
  case 2004:
    f->tui = enable ? 1 : 0;
    break;
  case 69:
    f->lrm = enable ? 1 : 0;
    break;
  case 1048:
    if (enable) vf_save_cursor(f); else vf_restore_cursor(f);
    break;
  case 47: case 1047: case 1049: {
    unsigned cur = f->screen, to = enable ? VF_ALT : VF_PRIMARY;
    /* Terminal.switchScreenMode: 1049 saves the cursor first, on the screen it
     * is on, even when it is already on the alternate screen. */
    if (mode == 1049 && enable) vf_save_cursor(f);
    if (to != cur) {
      if (!enable) f->ev_leave = 1;
      f->ev_switch = 1;
      f->screen = (uint8_t)to;
      /* the new screen's cursor is a copy of the old one's, style included */
      if (mode != 1049 || enable) f->fg[to] = f->fg[cur];
      /* A queued insertion is for the screen it was queued on. */
    }
    if (mode == 1049 && !enable) vf_restore_cursor(f);
    break;
  }
  default:
    break;
  }
}

/* ------------------------------------------------------------------------ */
/* kitty APC: the chunked-load tracker */

static int vf_kv_index(unsigned char k) {
  switch (k) {
  case 'a': return VK_A; case 't': return VK_T; case 'm': return VK_M; case 'f': return VK_F;
  case 'o': return VK_O; case 'q': return VK_Q; case 'C': return VK_C; case 'U': return VK_U;
  case 'i': return VK_I; case 'I': return VK_NUM;
  default: return -1;
  }
}

static void vf_apc_start(vf_t *f) {
  f->apc = VA_IDENT;
  f->id_len = 0;
}

static void vf_kitty_init(vf_t *f) {
  f->apc = VA_KITTY;
  f->kp = KP_KEY;
  f->kv_len = 0;
  f->kv_cur = 0;
  f->kv_err = 0;
  memset(f->kv, 0, sizeof(f->kv));
  f->d_len = 0;
  f->d_nonpad = 0;
  f->d_pad = 0;
  f->d_bad = 0;
}

static void vf_kv_store(vf_t *f, uint32_t v) {
  int k = vf_kv_index(f->kv_cur);
  if (k >= 0) { f->kv[k].v = v; f->kv[k].has = 1; }
}

/* std.fmt.parseInt(T, s, 10) as Zig implements it, which is what Ghostty's
 * CommandParser.finishValue calls: an optional sign, then digits with '_'
 * allowed anywhere except first or last after the sign, checked against the
 * range of T. A '-' is valid for an unsigned T only on zero. Returns 1 and the
 * stored bits (an i32 is stored as its u32 bit pattern), or 0 when Zig would
 * return an error. */
static int vf_parse_int(const uint8_t *s, unsigned n, int is_signed, uint32_t *out) {
  unsigned i = 0, start;
  int neg = 0;
  uint64_t mag = 0;
  if (n == 0) return 0;
  if (s[0] == '-') { neg = 1; i = 1; }
  else if (s[0] == '+') i = 1;
  start = i;
  if (i >= n || s[start] == '_' || s[n - 1] == '_') return 0;
  for (; i < n; i++) {
    if (s[i] == '_') continue;
    if (s[i] < '0' || s[i] > '9') return 0;
    mag = mag * 10 + (unsigned)(s[i] - '0');
    if (mag > 0xFFFFFFFFu) return 0;
  }
  if (is_signed) {
    if (neg ? mag > 0x80000000u : mag > 0x7FFFFFFFu) return 0;
    *out = neg ? (uint32_t)(0u - (uint32_t)mag) : (uint32_t)mag;
    return 1;
  }
  if (neg && mag != 0) return 0;
  *out = (uint32_t)mag;
  return 1;
}

/* CommandParser.finishValue. A value Ghostty rejects makes the whole command
 * fail (kv_err); every other value is stored exactly as Ghostty would. */
static void vf_kv_finish(vf_t *f) {
  unsigned n = f->kv_len;
  uint32_t v = 0;
  int is_signed = (f->kv_cur == 'z' || f->kv_cur == 'H' || f->kv_cur == 'V');
  f->kv_len = 0;
  if (n == 1 && (f->kv_tmp[0] < '0' || f->kv_tmp[0] > '9')) {
    vf_kv_store(f, f->kv_tmp[0]); /* a single character is stored as its code */
    return;
  }
  if (!vf_parse_int(f->kv_tmp, n, is_signed, &v)) { f->kv_err = 1; return; }
  vf_kv_store(f, v);
}

static void vf_kv_accum(vf_t *f, unsigned char c, unsigned overflow_state) {
  unsigned idx = f->kv_len;
  f->kv_len++;
  if (f->kv_len > sizeof(f->kv_tmp)) {
    f->kp = (uint8_t)overflow_state;
    f->kv_len = 0;
    return;
  }
  f->kv_tmp[idx] = c;
}

/* One byte of the control section, or the first byte of the payload. */
static void vf_kitty_byte(vf_t *f, unsigned char c) {
  switch (f->kp) {
  case KP_KEY:
    if (c == '=') {
      if (f->kv_len != 1) { f->kp = KP_VAL_IGN; f->kv_len = 0; }
      else { f->kv_cur = f->kv_tmp[0]; f->kv_len = 0; f->kp = KP_VAL; }
    } else if (c == ';') {
      f->kp = KP_DATA;
    } else {
      vf_kv_accum(f, c, KP_KEY_IGN);
    }
    break;
  case KP_KEY_IGN:
    if (c == '=') f->kp = KP_VAL_IGN;
    break;
  case KP_VAL:
    if (c == ',') { f->kp = KP_KEY; vf_kv_finish(f); }
    else if (c == ';') { f->kp = KP_DATA; vf_kv_finish(f); }
    else vf_kv_accum(f, c, KP_VAL_IGN);
    break;
  case KP_VAL_IGN:
    if (c == ',') f->kp = KP_KEY_IGN;
    else if (c == ';') f->kp = KP_DATA;
    break;
  default:
    break;
  }
}

/* Payload class: 0 base64 alphabet, 1 '=', 2 anything else. */
static const uint8_t vf_b64_class[256] = {
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 1, 2, 2,
  2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2,
  2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
};

static void vf_data_run(vf_t *f, const unsigned char *p, size_t n) {
  size_t i;
  uint64_t nonpad = 0;
  uint8_t pad = f->d_pad, bad = f->d_bad;
  f->d_len += n;
  for (i = 0; i < n; i++) {
    unsigned k = vf_b64_class[p[i]];
    if (k == 0) { nonpad++; if (pad) bad = 1; }
    else if (k == 1) { if (pad < 3) pad++; }
    else bad = 1;
  }
  f->d_nonpad += nonpad;
  f->d_pad = pad;
  f->d_bad = bad;
}

/* A run of bytes that are all apc_put bytes in Ghostty's table. */
static void vf_apc_run(vf_t *f, const unsigned char *p, size_t n) {
  size_t i = 0;
  while (i < n) {
    if (f->apc == VA_IGNORE) return;
    if (f->apc == VA_IDENT) {
      unsigned char c = p[i++];
      if (f->id_len == 0 && c == 'G') vf_kitty_init(f);
      else if (c == ';') f->apc = VA_IGNORE;
      else if (f->id_len >= sizeof(f->id_buf)) f->apc = VA_IGNORE;
      else f->id_buf[f->id_len++] = c;
      continue;
    }
    if (f->apc == VA_KITTY) {
      if (f->kp == KP_DATA) {
        vf_data_run(f, p + i, n - i);
        return;
      }
      vf_kitty_byte(f, p[i++]);
      continue;
    }
    return;
  }
}

/* apc_end: the command is complete. Decides whether a chunked load is open. */
static void vf_apc_end(vf_t *f) {
  unsigned s = f->screen;
  uint8_t kind = f->apc;
  uint32_t a;
  int action, more, medium_direct, certain, would_open;
  f->apc = VA_NONE;
  if (kind != VA_KITTY) return;

  /* Parser.complete */
  if (f->kp == KP_KEY || f->kp == KP_KEY_IGN) return;
  if (f->kp == KP_VAL) vf_kv_finish(f);
  if (f->kv_err) return;
  if (f->d_len > VF_APC_MAX) return;

  a = f->kv[VK_A].has ? f->kv[VK_A].v : 't';
  if (a > 255) return;
  action = (int)a;
  if (action != 't' && action != 'T') return; /* the other actions never touch a load */
  if (f->kv[VK_Q].has && f->kv[VK_Q].v > 2) return;
  if (f->kv[VK_F].has && !(f->kv[VK_F].v == 24 || f->kv[VK_F].v == 32 || f->kv[VK_F].v == 100)) return;
  if (f->kv[VK_T].has) {
    uint32_t t = f->kv[VK_T].v;
    if (!(t == 'd' || t == 'f' || t == 't' || t == 's')) return;
  }
  if (f->kv[VK_O].has && f->kv[VK_O].v != 'z') return;
  if (action == 'T') {
    if (f->kv[VK_C].has && f->kv[VK_C].v > 1) return;
    if (f->kv[VK_U].has && f->kv[VK_U].v > 1) return;
  }
  /* transmit(): both an id and a number is rejected before the load is touched */
  if (f->kv[VK_I].has && f->kv[VK_I].v > 0 && f->kv[VK_NUM].has && f->kv[VK_NUM].v > 0) return;

  medium_direct = !f->kv[VK_T].has || f->kv[VK_T].v == 'd';
  more = medium_direct && f->kv[VK_M].has && f->kv[VK_M].v > 0;

  /* The payload must decode as base64, otherwise the command is dropped. The
   * filter is sure only of the plain forms. */
  certain = !f->d_bad && f->d_nonpad % 4 != 1 &&
            (f->d_pad == 0 || (f->d_pad <= 2 && (f->d_nonpad + f->d_pad) % 4 == 0));
  would_open = more;
  if (certain) f->chunk[s] = (uint8_t)would_open;
  else if (would_open) f->chunk[s] = 1;
}

/* ------------------------------------------------------------------------ */
/* Lexer */

static void vf_clear_params(vf_t *f) {
  f->ni = 0;
  f->np = 0;
  f->colon = 0;
  f->acc = 0;
  f->acc_has = 0;
}

static void vf_reset_terminal(vf_t *f) {
  /* RIS: Ghostty drops the alternate screen and resets the primary, images included. */
  f->fg[0] = f->fg[1] = VF_FG_NONE;
  f->saved_fg[0] = f->saved_fg[1] = VF_FG_NONE;
  f->has_saved[0] = f->has_saved[1] = 0;
  f->screen = VF_PRIMARY;
  f->chunk[0] = f->chunk[1] = 0;
  f->tui = 0;
  f->lrm = 0;
  memset(f->mval, 0, sizeof f->mval);
  memset(f->msaved, 0, sizeof f->msaved);
  vf_clear_loaded(f, 0);
  vf_clear_loaded(f, 1);
  f->nq = 0;
  f->ev_switch = 0;
  f->ev_leave = 0;
}

static void vf_csi_dispatch(vf_t *f, unsigned char fin) {
  unsigned i;
  if (f->np >= VF_MAX_PARAMS) return;           /* Ghostty drops the dispatch */
  if (f->acc_has) f->params[f->np++] = f->acc;
  if (fin != 'm' && f->colon) return;           /* colons are only valid in SGR */
  switch (fin) {
  case 'm':
    if (f->ni == 0) vf_sgr(f);
    break;
  case 'h': case 'l':
    if (f->ni == 1 && f->inter[0] == '?')
      for (i = 0; i < f->np; i++) vf_mode(f, f->params[i], fin == 'h');
    break;
  case 's':
    if (f->ni == 0 && f->np == 0 && !f->lrm) vf_save_cursor(f);
    else if (f->ni == 1 && f->inter[0] == '?') {         /* XTSAVE */
      for (i = 0; i < f->np; i++) {
        int slot = vf_mode_slot(f->params[i]);
        if (slot >= 0) f->msaved[slot] = f->mval[slot];
      }
    }
    break;
  case 'r':
    if (f->ni == 1 && f->inter[0] == '?') {              /* XTRESTORE */
      for (i = 0; i < f->np; i++) {
        int slot = vf_mode_slot(f->params[i]);
        if (slot >= 0) vf_mode(f, f->params[i], f->msaved[slot]);
      }
    }
    break;
  case 'u':
    if (f->ni == 0) vf_restore_cursor(f);
    break;
  default:
    break;
  }
}

static void vf_esc_dispatch(vf_t *f, unsigned char fin) {
  if (f->ni != 0) return;
  switch (fin) {
  case '7': vf_save_cursor(f); break;
  case '8': vf_restore_cursor(f); break;
  case 'c':
    vf_reset_terminal(f);
    f->ev_switch = 1;
    break;
  default: break;
  }
}

#define VF_IN(c, lo, hi) ((c) >= (lo) && (c) <= (hi))

/* One byte in a non-ground state: parse_table.zig, state by state. Actions that
 * do not matter here (execute, ignore, print) are not modelled. */
static void vf_lex(vf_t *f, unsigned char c) {
  unsigned st = f->st, ns = st;
  enum { A_NONE, A_COLLECT, A_PARAM, A_ESCD, A_CSID, A_APCPUT } act = A_NONE;

  if (st == VF_OSC && c >= 0x20) return;         /* osc_put, C1 bytes included */

  if (c == 0x18 || c == 0x1A) { ns = VF_GROUND; goto go; }
  if (c == 0x1B) { ns = VF_ESCAPE; goto go; }
  if (c >= 0x80 && c <= 0x9F) {
    if (c == 0x90) ns = VF_DCS_ENTRY;
    else if (c == 0x98 || c == 0x9E || c == 0x9F) ns = VF_APC;
    else if (c == 0x9B) ns = VF_CSI_ENTRY;
    else if (c == 0x9D) ns = VF_OSC;
    else ns = VF_GROUND;                         /* 80-8F, 91-97, 99, 9A, 9C */
    goto go;
  }

  switch (st) {
  case VF_ESCAPE:
    if (VF_IN(c, 0x20, 0x2F)) { ns = VF_ESC_INTER; act = A_COLLECT; }
    else if (c == 0x58 || c == 0x5E || c == 0x5F) ns = VF_APC;
    else if (c == 0x50) ns = VF_DCS_ENTRY;
    else if (c == 0x5B) ns = VF_CSI_ENTRY;
    else if (c == 0x5D) ns = VF_OSC;
    else if (VF_IN(c, 0x30, 0x7E)) { ns = VF_GROUND; act = A_ESCD; }
    break;
  case VF_ESC_INTER:
    if (VF_IN(c, 0x20, 0x2F)) act = A_COLLECT;
    else if (VF_IN(c, 0x30, 0x7E)) { ns = VF_GROUND; act = A_ESCD; }
    break;
  case VF_APC:
    if (c <= 0x7F && c != 0x18 && c != 0x1A && c != 0x1B) act = A_APCPUT;
    break;
  case VF_DCS_ENTRY:
    if (VF_IN(c, 0x20, 0x2F)) { ns = VF_DCS_INTER; act = A_COLLECT; }
    else if (c == 0x3A) ns = VF_DCS_IGNORE;
    else if (VF_IN(c, 0x30, 0x39) || c == 0x3B) { ns = VF_DCS_PARAM; act = A_PARAM; }
    else if (VF_IN(c, 0x3C, 0x3F)) { ns = VF_DCS_PARAM; act = A_COLLECT; }
    else if (VF_IN(c, 0x40, 0x7E)) ns = VF_DCS_PASS;
    break;
  case VF_DCS_INTER:
    if (VF_IN(c, 0x20, 0x2F)) act = A_COLLECT;
    else if (VF_IN(c, 0x30, 0x3F)) ns = VF_DCS_IGNORE;
    else if (VF_IN(c, 0x40, 0x7E)) ns = VF_DCS_PASS;
    break;
  case VF_DCS_PARAM:
    if (VF_IN(c, 0x30, 0x39) || c == 0x3B) act = A_PARAM;
    else if (c == 0x3A || VF_IN(c, 0x3C, 0x3F)) ns = VF_DCS_IGNORE;
    else if (VF_IN(c, 0x20, 0x2F)) { ns = VF_DCS_INTER; act = A_COLLECT; }
    else if (VF_IN(c, 0x40, 0x7E)) ns = VF_DCS_PASS;
    break;
  case VF_DCS_PASS:
  case VF_DCS_IGNORE:
    break;
  case VF_CSI_PARAM:
    if (VF_IN(c, 0x30, 0x3B)) act = A_PARAM;       /* digits, ':' and ';' */
    else if (VF_IN(c, 0x40, 0x7E)) { ns = VF_GROUND; act = A_CSID; }
    else if (VF_IN(c, 0x3C, 0x3F)) ns = VF_CSI_IGNORE;
    else if (VF_IN(c, 0x20, 0x2F)) { ns = VF_CSI_INTER; act = A_COLLECT; }
    break;
  case VF_CSI_IGNORE:
    if (VF_IN(c, 0x40, 0x7E)) ns = VF_GROUND;
    break;
  case VF_CSI_INTER:
    if (VF_IN(c, 0x20, 0x2F)) act = A_COLLECT;
    else if (VF_IN(c, 0x40, 0x7E)) { ns = VF_GROUND; act = A_CSID; }
    else if (VF_IN(c, 0x30, 0x3F)) ns = VF_CSI_IGNORE;
    break;
  case VF_CSI_ENTRY:
    if (VF_IN(c, 0x40, 0x7E)) { ns = VF_GROUND; act = A_CSID; }
    else if (c == 0x3A) ns = VF_CSI_IGNORE;
    else if (VF_IN(c, 0x20, 0x2F)) { ns = VF_CSI_INTER; act = A_COLLECT; }
    else if (VF_IN(c, 0x30, 0x39) || c == 0x3B) { ns = VF_CSI_PARAM; act = A_PARAM; }
    else if (VF_IN(c, 0x3C, 0x3F)) { ns = VF_CSI_PARAM; act = A_COLLECT; }
    break;
  case VF_OSC:
    if (c == 0x07) ns = VF_GROUND;
    break;
  default:
    break;
  }

go:
  if (st != ns && st == VF_APC) vf_apc_end(f);
  switch (act) {
  case A_COLLECT:
    if (f->ni < 4) f->inter[f->ni++] = c;
    break;
  case A_PARAM:
    if (c == ';' || c == ':') {
      if (f->np < VF_MAX_PARAMS) {
        f->params[f->np] = f->acc;
        if (c == ':') f->colon |= 1u << f->np;
        f->np++;
        f->acc = 0;
        f->acc_has = 0;
      }
    } else {
      /* saturating, like Ghostty's u16 accumulator */
      unsigned v = (unsigned)f->acc * 10u + (unsigned)(c - '0');
      f->acc = (uint16_t)(v > 0xFFFFu ? 0xFFFFu : v);
      f->acc_has = 1;
    }
    break;
  case A_ESCD:
    vf_esc_dispatch(f, c);
    break;
  case A_CSID:
    vf_csi_dispatch(f, c);
    break;
  case A_APCPUT:
    vf_apc_run(f, &c, 1);
    break;
  default:
    break;
  }
  if (st != ns) {
    if (ns == VF_ESCAPE || ns == VF_DCS_ENTRY || ns == VF_CSI_ENTRY) vf_clear_params(f);
    if (ns == VF_APC) vf_apc_start(f);
    if (ns == VF_GROUND) f->after_seq = 1;
  }
  f->st = (uint8_t)ns;
}

/* One byte in the ground state: UTF-8 decoding first, as Ghostty's stream does.
 * Only ESC reaches the parser. Returns 1 when the byte completed a placeholder. */
static int vf_ground(vf_t *f, unsigned char b, uint64_t at_in) {
  int ph = 0;
  for (;;) {
    uint32_t cp = 0;
    int consumed = 1;
    if (vf_u8_next(f, b, &cp, &consumed)) {
      if (cp == 0x1B) {
        f->st = VF_ESCAPE;
        vf_clear_params(f);
      } else {
        f->after_seq = 0;
        if (cp == 0x10EEEE) {
          vf_trigger(f, f->holding ? f->hold_in : at_in);
          ph = 1;
          /* the start of the cell is already out, so the transmit waits for a boundary */
          if (!f->holding) vf_q_mark_deferred(f, 0);
        }
      }
    }
    if (consumed) break;
  }
  return ph;
}

/* ------------------------------------------------------------------------ */
/* Public interface */

static void vf_init(vf_t *f, const char *session_dir) {
  size_t n;
  memset(f, 0, sizeof(*f));
  f->st = VF_GROUND;
  f->fg[0] = f->fg[1] = VF_FG_NONE;
  f->saved_fg[0] = f->saved_fg[1] = VF_FG_NONE;
  f->mru_idx = -1;
  f->uid = geteuid();
  if (session_dir) {
    n = strlen(session_dir);
    if (n > 0 && n <= VF_DIR_MAX && session_dir[0] == '/') {
      memcpy(f->dir, session_dir, n);
      f->dir_len = (uint16_t)n;
      f->enabled = 1;
    }
  }
}

/* Writes the held bytes, unchanged. The region is given up as an insertion point. */
static void vf_release(vf_t *f, vf_io *io) {
  if (f->hn) vf_put(io, f->hold, f->hn);
  f->hn = 0;
  f->holding = 0;
}

/* The region that began at a ground point has ended at another. Everything
 * that must go in front of it goes in now. A placeholder or a screen switch is
 * a safe thing to insert before; any other region is left to vf_boundary, which
 * knows whether a combining mark could follow. */
static void vf_region_done(vf_t *f, vf_io *io, int ph) {
  uint64_t at = f->hold_in;
  unsigned s = f->ins_screen;
  int blocked = f->chunk[s];
  if ((ph || f->ev_switch) && f->nq) {
    if (blocked) vf_q_mark_deferred(f, 1);
    else if (f->op_screen == s) vf_q_emit(f, io, at);
    else vf_q_drop_all(f);
  }
  if (f->ev_leave) {
    if (blocked) f->stats.leave_skipped++;
    else vf_free_screen(f, io, VF_ALT, at, &f->stats.deletes_leave); /* the alternate screen is active here */
  }
  f->ev_switch = 0;
  f->ev_leave = 0;
  vf_release(f, io);
}

/* The filter is at a ground point between two items. Lets queued operations out
 * if it is safe: not between a character and the combining marks that may follow. */
static void vf_boundary(vf_t *f, vf_io *io, uint64_t at, int next_is_safe) {
  if (!f->nq || f->holding) return;
  if (f->st != VF_GROUND || f->u_state != 0) return;
  if (!next_is_safe && !f->after_seq) return;
  if (f->chunk[f->screen]) {
    vf_q_mark_deferred(f, 1);
    return;
  }
  if (f->op_screen != f->screen) { vf_q_drop_all(f); return; }
  vf_q_emit(f, io, at);
}

static size_t vf_feed(vf_t *f, const unsigned char *in, size_t n, unsigned char *out, size_t cap) {
  vf_io io;
  size_t i = 0;
  io.out = out; io.cap = cap; io.o = 0; io.ub = n; io.in_n = n; io.lost = 0;
  vf_cuts_begin(f);
  f->tx_call = 0;
  f->lookups = 0;
  f->dir_checked = 0;
#ifdef VF_LOG
  f->log_n = 0;
  f->log_over = 0;
#endif

  while (i < n) {
    unsigned char b = in[i];
    int ph = 0;
    io.ub = n - i;

    if (!f->holding) {
      if (f->st == VF_GROUND && f->u_state == 0) {
        /* a ground point, before in[i] */
        if (b < 0x80 && b != 0x1B) {
          size_t j = i + 1, off;
          if (f->nq) vf_boundary(f, &io, f->in_base + i, 1);
          while (j < n && in[j] < 0x80 && in[j] != 0x1B) j++;
          /* before every ASCII byte is a safe point; the run's last one stays out so that
           * a combining mark that starts the next read is not parted from its base */
          for (off = 0; off < j - i; off += VF_CUT_GAP) vf_cut(f, io.o + off);
          if (j - i > 1) vf_cut(f, io.o + (j - i) - 1);
          f->after_seq = 0;
          vf_put(&io, in + i, j - i);
          i = j;
          continue;
        }
        if (f->nq) vf_boundary(f, &io, f->in_base + i, b == 0x1B);
        if (b == 0x1B || f->after_seq) vf_cut(f, io.o);
        f->holding = 1;
        f->hn = 0;
        f->hold_in = f->in_base + i;
        f->ins_screen = f->screen;
        f->ev_switch = 0;
        f->ev_leave = 0;
      } else if (f->st == VF_APC) {
        /* the bulk of Codex's traffic: chunks of image data */
        size_t j = i;
        while (j < n && in[j] <= 0x7F && in[j] != 0x18 && in[j] != 0x1A && in[j] != 0x1B) j++;
        if (j > i) {
          vf_apc_run(f, in + i, j - i);
          vf_put(&io, in + i, j - i);
          i = j;
          continue;
        }
      }
    }

    if (f->holding) f->hold[f->hn++] = b;
    if (f->st == VF_GROUND) ph = vf_ground(f, b, f->in_base + i);
    else vf_lex(f, b);
    i++;
    io.ub = n - i;

    if (f->holding) {
      if (f->st == VF_GROUND && f->u_state == 0) {
        vf_region_done(f, &io, ph);
      } else if (f->st >= VF_DCS_ENTRY) {
        vf_release(f, &io);
      } else if (f->hn >= VF_HOLD_MAX) {
        f->stats.hold_overflow++;
        vf_release(f, &io);
      }
    } else {
      /* a byte of a sequence or character that is no longer held */
      vf_put(&io, &b, 1);
      if (f->ev_leave) f->stats.leave_skipped++; /* too late to go in front of it */
      f->ev_switch = 0;
      f->ev_leave = 0;
    }
  }
  /* the call ends after a complete sequence: the next byte, whatever it is, may follow it */
  if (!f->holding && f->st == VF_GROUND && f->u_state == 0 && f->after_seq) vf_cut(f, io.o);
  vf_cuts_end(f);
  f->in_base += n;
  f->out_base += io.o;
  f->stats.dropped_data += io.lost;
  return io.o;
}

static size_t vf_flush(vf_t *f, unsigned char *out, size_t cap) {
  vf_io io;
  io.out = out; io.cap = cap; io.o = 0; io.ub = 0; io.in_n = 0; io.lost = 0;
#ifdef VF_LOG
  f->log_n = 0;
  f->log_over = 0;
#endif
  vf_cuts_begin(f);
  vf_release(f, &io);
  vf_boundary(f, &io, f->in_base, 0);
  if (io.o > 0 && f->st == VF_GROUND && f->u_state == 0 && f->after_seq) vf_cut(f, io.o);
  vf_cuts_end(f);
  f->out_base += io.o;
  f->stats.dropped_data += io.lost;
  return io.o;
}

static size_t vf_finish(vf_t *f, unsigned char *out, size_t cap) {
  vf_io io;
  io.out = out; io.cap = cap; io.o = 0; io.ub = 0; io.in_n = 0; io.lost = 0;
#ifdef VF_LOG
  f->log_n = 0;
  f->log_over = 0;
#endif
  vf_cuts_begin(f);
  vf_release(f, &io);
  if (!f->finished && f->st == VF_GROUND && f->u_state == 0 && !f->chunk[f->screen]) {
    /* transmits that never went out are dropped, evictions are still due */
    if (f->op_screen != f->screen) vf_q_drop_all(f);
    vf_free_screen(f, &io, f->screen, f->in_base, &f->stats.deletes_finish);
    f->nq = 0;
  }
  f->finished = 1;
  if (io.o > 0 && f->st == VF_GROUND && f->u_state == 0 && f->after_seq) vf_cut(f, io.o);
  vf_cuts_end(f);
  f->out_base += io.o;
  f->stats.dropped_data += io.lost;
  return io.o;
}

/* Bytes held back, plus one when a queued insertion could go out at this very point but is
 * waiting for the relay's timer (so that it is not stuck behind a Codex that has gone quiet). */
static int vf_held(const vf_t *f) {
  int ready = f->nq && !f->holding && f->st == VF_GROUND && f->u_state == 0 && f->after_seq &&
              !f->chunk[f->screen] && f->op_screen == f->screen;
  return f->hn + (ready ? 1 : 0);
}
static int vf_tui(const vf_t *f) { return f->tui; }
/* The safe cut points of the last vf_feed, vf_flush or vf_finish: offsets into that
 * call's output, ascending. Valid until the next call. */
static unsigned vf_cuts(const vf_t *f, const uint32_t **offs) {
  *offs = f->cut;
  return f->ncut;
}
static unsigned vf_transmits(const vf_t *f) { return f->transmits; }

/* Additions for tests and measurement. */
#if defined(__GNUC__)
#define VF_UNUSED __attribute__((unused))
#else
#define VF_UNUSED
#endif
VF_UNUSED static const vf_stats_t *vf_get_stats(const vf_t *f) { return &f->stats; }
/* Bit 0: lexer in GROUND. Bit 1: UTF-8 decoder idle. Bit 2: a chunked load is
 * open on the active screen. Bit 3: alternate screen. Bit 4: bracketed paste. */
VF_UNUSED static unsigned vf_dbg_flags(const vf_t *f) {
  return (f->st == VF_GROUND ? 1u : 0u) | (f->u_state == 0 ? 2u : 0u) | (f->chunk[f->screen] ? 4u : 0u) |
         (f->screen == VF_ALT ? 8u : 0u) | (f->tui ? 16u : 0u);
}
VF_UNUSED static int32_t vf_dbg_fg(const vf_t *f) { return f->fg[f->screen]; }
VF_UNUSED static unsigned vf_dbg_loaded(const vf_t *f, unsigned screen) { return f->n_loaded[screen & 1]; }

#endif
