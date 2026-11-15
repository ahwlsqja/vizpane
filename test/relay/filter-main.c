/*
 * Test driver for plugins/vizpane/inline/relay-filter.h. No pty is involved.
 *
 *   filter-main <session-dir|-> [mode] [options] < stream > output 2> log
 *
 * Reads the whole stream from stdin and feeds it to the filter in chunks. The
 * output goes to stdout. stderr gets one line per insertion,
 *
 *   INS <in_offset> <out_offset> <len> T|D <id>
 *
 * where in_offset is the input byte the insertion sits in front of and out_offset
 * is where the inserted bytes start in the output. After the last insertion,
 *
 *   STAT key=value ...
 *
 * has the filter's counters, and, with --time,
 *
 *   TIME feeds=<n> bytes=<n> total_ns=<n> max_ns=<n> p99_ns=<n>
 *
 * Modes (default: one chunk):
 *   --split N            two chunks, the first N bytes and the rest
 *   --chunk N            chunks of N bytes
 *   --random SEED [MAX]  chunks of 1..MAX bytes (default 4096) from a seeded generator; about one
 *                        chunk in eight is followed by vf_flush, as the relay does after 5 ms of silence
 * Options:
 *   --flush              call vf_flush after every chunk
 *   --trace FILE         feed one byte at a time and write, for the position before every input byte
 *                        and after the last one, 5 bytes: vf_dbg_flags and the foreground (int32,
 *                        little endian; -1 is none)
 *   --tight              give the filter no more room than its contract (n + VF_SLACK) on every call
 *   --time               measure the time of every vf_feed
 *   --copy OFFSET SRC DST  when OFFSET input bytes have been fed, copy file SRC to DST (the way the
 *                        hook publishes an image while the relay runs); may be repeated
 *   --multi              the input is a series of [u32 little endian length][stream]. Each stream gets a
 *                        fresh filter. stdout is a series of [u32 length][output]; stderr has a line
 *                        "STREAM <k>" before the lines of stream k
 *   --calls FILE         after every vf_feed and vf_flush write a line "F|L <input bytes fed> <output bytes
 *                        produced> <vf_held>" (cumulative), to see what the filter holds back
 *   --cuts FILE          after every vf_feed, vf_flush and the final vf_finish write a line
 *                        "K F|L|E <output bytes before the call> <output bytes of the call> <n> <offset>..."
 *                        with the safe cut points the call reported (offsets into its own output);
 *                        a line "S" starts each stream
 *   --each-split         run the input once for every split position 0..n, as --multi does for several
 *                        streams (stream k is the one split after k bytes). With --flush, the filter is
 *                        flushed at the split, as after 5 ms of silence
 *
 * Exit status 0, or 2 on a usage or I/O error.
 */
#define VF_LOG
#include "../../plugins/vizpane/inline/relay-filter.h"

#include <stdio.h>
#include <stdlib.h>
#include <time.h>

typedef struct {
  size_t offset;
  const char *src, *dst;
} copy_t;

typedef struct {
  size_t split, chunk, maxchunk;
  int split_mode, random_mode, flush_each;
  const char *trace_path;
} feed_mode_t;

static uint64_t rng_state;
static vf_t g_vf;
static unsigned char *g_out;
static size_t g_out_cap;
static uint64_t *g_times;
static size_t g_ntimes, g_times_cap;
static int g_time;
static int g_multi;
static int g_each_split;
static int g_tight;
static FILE *g_calls;
static FILE *g_cuts;
static uint64_t g_cut_total;
static uint64_t g_in_total, g_out_total;
static copy_t g_copies[16];
static int g_ncopies;
static const char *g_dir;

static uint64_t rng_next(void) {
  /* xorshift64*, enough for chunk sizes */
  rng_state ^= rng_state >> 12;
  rng_state ^= rng_state << 25;
  rng_state ^= rng_state >> 27;
  return rng_state * 0x2545F4914F6CDD1DULL;
}

static uint64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static int cmp_u64(const void *a, const void *b) {
  uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
  return x < y ? -1 : x > y;
}

static void die(const char *msg) {
  fprintf(stderr, "%s\n", msg);
  exit(2);
}

static unsigned char *read_all(size_t *len) {
  size_t cap = 1 << 20, n = 0;
  unsigned char *buf = malloc(cap);
  if (!buf) return NULL;
  for (;;) {
    size_t r;
    if (n == cap) {
      unsigned char *nb = realloc(buf, cap * 2);
      if (!nb) { free(buf); return NULL; }
      buf = nb;
      cap *= 2;
    }
    r = fread(buf + n, 1, cap - n, stdin);
    if (r == 0) break;
    n += r;
  }
  *len = n;
  return buf;
}

/* Output of one stream goes to a growing buffer in --multi mode, so that its length can be written first. */
static unsigned char *g_acc;
static size_t g_acc_n, g_acc_cap;

static void emit_out(const unsigned char *p, size_t n) {
  if (!n) return;
  if (g_multi) {
    if (g_acc_n + n > g_acc_cap) {
      g_acc_cap = (g_acc_n + n) * 2;
      g_acc = realloc(g_acc, g_acc_cap);
      if (!g_acc) die("out of memory");
    }
    memcpy(g_acc + g_acc_n, p, n);
    g_acc_n += n;
  } else if (fwrite(p, 1, n, stdout) != n) {
    die("write error");
  }
}

static void print_log(void) {
  uint16_t i;
  for (i = 0; i < g_vf.log_n; i++) {
    const vf_logent_t *e = &g_vf.log[i];
    fprintf(stderr, "INS %llu %llu %u %c %u\n", (unsigned long long)e->in_off,
            (unsigned long long)e->out_off, e->len, e->kind, e->id);
  }
  if (g_vf.log_over) die("LOGOVERFLOW");
}

static void note_cuts(char kind, size_t o) {
  const uint32_t *offs;
  unsigned n, i;
  if (!g_cuts) return;
  n = vf_cuts(&g_vf, &offs);
  fprintf(g_cuts, "K %c %llu %zu %u", kind, (unsigned long long)g_cut_total, o, n);
  for (i = 0; i < n; i++) fprintf(g_cuts, " %u", offs[i]);
  fputc('\n', g_cuts);
  g_cut_total += o;
}

static void do_feed(const unsigned char *in, size_t n) {
  uint64_t t0 = 0;
  size_t o;
  if (n + VF_SLACK > g_out_cap) die("chunk too large");
  if (g_time) t0 = now_ns();
  o = vf_feed(&g_vf, in, n, g_out, g_tight ? n + VF_SLACK : g_out_cap);
  if (g_time) {
    if (g_ntimes == g_times_cap) {
      g_times_cap = g_times_cap ? g_times_cap * 2 : 1024;
      g_times = realloc(g_times, g_times_cap * sizeof(uint64_t));
      if (!g_times) die("out of memory");
    }
    g_times[g_ntimes++] = now_ns() - t0;
  }
  emit_out(g_out, o);
  print_log();
  note_cuts('F', o);
  g_in_total += n;
  g_out_total += o;
  if (g_calls) fprintf(g_calls, "F %llu %llu %d\n", (unsigned long long)g_in_total, (unsigned long long)g_out_total, vf_held(&g_vf));
}

static void do_flush(void) {
  size_t o = vf_flush(&g_vf, g_out, g_tight ? VF_SLACK : g_out_cap);
  emit_out(g_out, o);
  print_log();
  note_cuts('L', o);
  g_out_total += o;
  if (g_calls) fprintf(g_calls, "L %llu %llu %d\n", (unsigned long long)g_in_total, (unsigned long long)g_out_total, vf_held(&g_vf));
}

static void copy_file(const char *src, const char *dst) {
  char tmp[4096];
  FILE *a, *b;
  char buf[65536];
  size_t r;
  struct timespec ts = {0, 20 * 1000 * 1000};
  nanosleep(&ts, NULL); /* let the directory's mtime tick over */
  snprintf(tmp, sizeof(tmp), "%s.tmp", dst);
  a = fopen(src, "rb");
  b = fopen(tmp, "wb");
  if (!a || !b) die("copy failed");
  while ((r = fread(buf, 1, sizeof(buf), a)) > 0) if (fwrite(buf, 1, r, b) != r) die("copy failed");
  fclose(a);
  if (fclose(b) != 0 || rename(tmp, dst) != 0) die("copy failed");
}

/* Feeds in[a..b) according to the mode. */
static void feed_range(const unsigned char *in, size_t a, size_t b, const feed_mode_t *m) {
  size_t pos = a;
  while (pos < b) {
    size_t k;
    if (m->random_mode) k = 1 + (size_t)(rng_next() % m->maxchunk);
    else k = m->chunk;
    if (k > b - pos) k = b - pos;
    do_feed(in + pos, k);
    pos += k;
    if (m->flush_each || (m->random_mode && (rng_next() & 7) == 0)) do_flush();
  }
}

static void run_stream(const unsigned char *in, size_t n, const feed_mode_t *m, FILE *trace) {
  size_t cuts[18], ncuts = 0, pos = 0, i, j;
  int c;
  vf_init(&g_vf, g_dir);
  g_in_total = g_out_total = 0;
  g_cut_total = 0;
  if (g_calls) fprintf(g_calls, "S\n");
  if (g_cuts) fprintf(g_cuts, "S\n");
  if (trace) {
    for (i = 0; i <= n; i++) {
      unsigned char rec[5];
      int32_t fg = vf_dbg_fg(&g_vf);
      rec[0] = (unsigned char)vf_dbg_flags(&g_vf);
      rec[1] = (unsigned char)(fg & 0xFF);
      rec[2] = (unsigned char)((fg >> 8) & 0xFF);
      rec[3] = (unsigned char)((fg >> 16) & 0xFF);
      rec[4] = (unsigned char)((fg >> 24) & 0xFF);
      if (fwrite(rec, 1, 5, trace) != 5) die("trace write error");
      if (i < n) do_feed(in + i, 1);
    }
  } else {
    /* cut points: where the stream must be split for a copy or for --split */
    for (c = 0; c < g_ncopies; c++) if (g_copies[c].offset <= n) cuts[ncuts++] = g_copies[c].offset;
    if (m->split_mode) cuts[ncuts++] = m->split > n ? n : m->split;
    for (i = 0; i < ncuts; i++)
      for (j = i + 1; j < ncuts; j++)
        if (cuts[j] < cuts[i]) { size_t t = cuts[i]; cuts[i] = cuts[j]; cuts[j] = t; }
    cuts[ncuts++] = n;
    for (i = 0; i < ncuts; i++) {
      feed_range(in, pos, cuts[i], m);
      pos = cuts[i];
      for (c = 0; c < g_ncopies; c++) if (g_copies[c].offset == pos) copy_file(g_copies[c].src, g_copies[c].dst);
      if (m->split_mode && m->flush_each) do_flush();
    }
  }
  {
    size_t o = vf_finish(&g_vf, g_out, g_tight ? VF_SLACK : g_out_cap);
    emit_out(g_out, o);
    print_log();
    note_cuts('E', o);
  }
  {
    const vf_stats_t *s = vf_get_stats(&g_vf);
    fprintf(stderr,
            "STAT triggers=%llu transmits=%llu deletes_leave=%llu deletes_lru=%llu deletes_finish=%llu "
            "deferred=%llu deferred_chunk=%llu deferred_unheld=%llu defer_bytes_sum=%llu defer_bytes_max=%llu absent_added=%llu "
            "dropped_no_room=%llu dropped_data=%llu hold_overflow=%llu leave_skipped=%llu held=%d tui=%d api_transmits=%u "
            "loaded_primary=%u loaded_alt=%u\n",
            (unsigned long long)s->triggers, (unsigned long long)s->transmits,
            (unsigned long long)s->deletes_leave, (unsigned long long)s->deletes_lru,
            (unsigned long long)s->deletes_finish, (unsigned long long)s->deferred,
            (unsigned long long)s->deferred_chunk, (unsigned long long)s->deferred_unheld,
            (unsigned long long)s->defer_bytes_sum,
            (unsigned long long)s->defer_bytes_max, (unsigned long long)s->absent_added,
            (unsigned long long)s->dropped_no_room, (unsigned long long)s->dropped_data, (unsigned long long)s->hold_overflow,
            (unsigned long long)s->leave_skipped, vf_held(&g_vf), vf_tui(&g_vf), vf_transmits(&g_vf),
            vf_dbg_loaded(&g_vf, 0), vf_dbg_loaded(&g_vf, 1));
  }
}

int main(int argc, char **argv) {
  size_t n = 0;
  unsigned char *in;
  feed_mode_t m;
  FILE *trace = NULL;
  int a;
  size_t maxfeed;

  memset(&m, 0, sizeof(m));
  m.maxchunk = 4096;
  if (argc < 2) die("usage: filter-main <session-dir|-> [--split N|--chunk N|--random SEED [MAX]] [--flush] [--trace FILE] [--time] [--copy OFFSET SRC DST] [--multi]");
  g_dir = strcmp(argv[1], "-") == 0 ? NULL : argv[1];
  for (a = 2; a < argc; a++) {
    if (strcmp(argv[a], "--split") == 0 && a + 1 < argc) { m.split_mode = 1; m.split = (size_t)strtoull(argv[++a], NULL, 10); }
    else if (strcmp(argv[a], "--chunk") == 0 && a + 1 < argc) { m.chunk = (size_t)strtoull(argv[++a], NULL, 10); }
    else if (strcmp(argv[a], "--random") == 0 && a + 1 < argc) {
      m.random_mode = 1;
      rng_state = strtoull(argv[++a], NULL, 10) * 0x9E3779B97F4A7C15ULL + 0x1234567ULL;
      if (rng_state == 0) rng_state = 1;
      if (a + 1 < argc && argv[a + 1][0] != '-') m.maxchunk = (size_t)strtoull(argv[++a], NULL, 10);
      if (m.maxchunk == 0) m.maxchunk = 1;
    } else if (strcmp(argv[a], "--flush") == 0) m.flush_each = 1;
    else if (strcmp(argv[a], "--trace") == 0 && a + 1 < argc) m.trace_path = argv[++a];
    else if (strcmp(argv[a], "--time") == 0) g_time = 1;
    else if (strcmp(argv[a], "--calls") == 0 && a + 1 < argc) { g_calls = fopen(argv[++a], "w"); if (!g_calls) die("cannot open calls file"); }
    else if (strcmp(argv[a], "--cuts") == 0 && a + 1 < argc) { g_cuts = fopen(argv[++a], "w"); if (!g_cuts) die("cannot open cuts file"); }
    else if (strcmp(argv[a], "--multi") == 0) g_multi = 1;
    else if (strcmp(argv[a], "--tight") == 0) g_tight = 1;
    else if (strcmp(argv[a], "--each-split") == 0) { g_multi = 1; g_each_split = 1; m.split_mode = 1; }
    else if (strcmp(argv[a], "--copy") == 0 && a + 3 < argc && g_ncopies < 16) {
      g_copies[g_ncopies].offset = (size_t)strtoull(argv[++a], NULL, 10);
      g_copies[g_ncopies].src = argv[++a];
      g_copies[g_ncopies].dst = argv[++a];
      g_ncopies++;
    } else die("unknown argument");
  }

  in = read_all(&n);
  if (!in) die("out of memory");
  if (m.trace_path) {
    trace = fopen(m.trace_path, "wb");
    if (!trace) die("cannot open trace file");
  }

  /* the largest chunk any feed will get */
  if (m.random_mode) maxfeed = m.maxchunk;
  else if (m.trace_path) maxfeed = 1;
  else if (m.split_mode || m.chunk == 0) maxfeed = n;
  else maxfeed = m.chunk;
  g_out_cap = maxfeed + VF_SLACK + 4096;
  g_out = malloc(g_out_cap);
  if (!g_out) die("out of memory");
  if (m.chunk == 0) m.chunk = n ? n : 1;

  if (g_each_split) {
    size_t k;
    for (k = 0; k <= n; k++) {
      unsigned char hdr[4];
      fprintf(stderr, "STREAM %zu\n", k);
      g_acc_n = 0;
      m.split = k;
      run_stream(in, n, &m, NULL);
      hdr[0] = (unsigned char)(g_acc_n & 0xFF); hdr[1] = (unsigned char)((g_acc_n >> 8) & 0xFF);
      hdr[2] = (unsigned char)((g_acc_n >> 16) & 0xFF); hdr[3] = (unsigned char)((g_acc_n >> 24) & 0xFF);
      if (fwrite(hdr, 1, 4, stdout) != 4 || (g_acc_n && fwrite(g_acc, 1, g_acc_n, stdout) != g_acc_n)) die("write error");
    }
    free(g_acc);
  } else if (g_multi) {
    size_t pos = 0, k = 0;
    if (!m.random_mode && !m.trace_path) die("--multi needs --random or --trace");
    while (pos + 4 <= n) {
      size_t len = (size_t)in[pos] | ((size_t)in[pos + 1] << 8) | ((size_t)in[pos + 2] << 16) | ((size_t)in[pos + 3] << 24);
      unsigned char hdr[4];
      pos += 4;
      if (pos + len > n) die("truncated multi input");
      fprintf(stderr, "STREAM %zu\n", k++);
      g_acc_n = 0;
      run_stream(in + pos, len, &m, trace);
      pos += len;
      hdr[0] = (unsigned char)(g_acc_n & 0xFF); hdr[1] = (unsigned char)((g_acc_n >> 8) & 0xFF);
      hdr[2] = (unsigned char)((g_acc_n >> 16) & 0xFF); hdr[3] = (unsigned char)((g_acc_n >> 24) & 0xFF);
      if (fwrite(hdr, 1, 4, stdout) != 4 || (g_acc_n && fwrite(g_acc, 1, g_acc_n, stdout) != g_acc_n)) die("write error");
    }
    free(g_acc);
  } else {
    run_stream(in, n, &m, trace);
  }
  if (trace) fclose(trace);
  if (g_calls) fclose(g_calls);
  if (g_cuts) fclose(g_cuts);
  if (fflush(stdout) != 0) die("write error");

  if (g_time && g_ntimes) {
    uint64_t total = 0, max = 0, p99;
    size_t i, idx;
    for (i = 0; i < g_ntimes; i++) { total += g_times[i]; if (g_times[i] > max) max = g_times[i]; }
    qsort(g_times, g_ntimes, sizeof(uint64_t), cmp_u64);
    idx = (g_ntimes * 99) / 100;
    if (idx >= g_ntimes) idx = g_ntimes - 1;
    p99 = g_times[idx];
    fprintf(stderr, "TIME feeds=%zu bytes=%zu total_ns=%llu max_ns=%llu p99_ns=%llu\n", g_ntimes, n,
            (unsigned long long)total, (unsigned long long)max, (unsigned long long)p99);
  }
  free(in);
  free(g_out);
  free(g_times);
  return 0;
}
