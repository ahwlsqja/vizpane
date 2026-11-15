/* Unit test of the relay's cut inside a run without safe cut points: the relay's source is
 * included so that its static function can be called. */
#define main relay_main
#include "../../plugins/vizpane/inline/relay.c"
#undef main

static int fail(const char *m) { printf("FAIL %s\n", m); return 1; }

int main(void) {
  unsigned char b[1200];
  size_t i, k;
  /* a run of 3-byte box characters (U+2500): the cut at 512 would be inside one (512 = 3 * 170 + 2) */
  for (i = 0; i + 3 <= sizeof b; i += 3) { b[i] = 0xE2; b[i + 1] = 0x94; b[i + 2] = 0x80; }
  k = utf8_cut(b, 512, sizeof b);
  if (k > 512 || k < 509 || k % 3 != 0) return fail("box run cut is not at a character start");
  /* placeholder cells: U+10EEEE (4 bytes) then two diacritics (2 bytes each), 8 bytes a cell */
  for (i = 0; i + 8 <= sizeof b; i += 8) {
    b[i] = 0xF4; b[i + 1] = 0x8E; b[i + 2] = 0xBB; b[i + 3] = 0xAE;
    b[i + 4] = 0xCC; b[i + 5] = 0x85; b[i + 6] = 0xCD; b[i + 7] = 0x8D;
  }
  k = utf8_cut(b, 516, sizeof b);   /* in the middle of a cell, at a diacritic */
  if (k != 512) return fail("placeholder run is cut away from its marks");
  k = utf8_cut(b, 512, sizeof b);
  if (k != 512) return fail("cut at a cell start moved");
  /* ASCII needs no backing off */
  memset(b, 'a', sizeof b);
  if (utf8_cut(b, 512, sizeof b) != 512) return fail("ASCII cut moved");
  /* nothing but continuation bytes: keep n rather than return 0 */
  memset(b, 0x80, sizeof b);
  if (utf8_cut(b, 512, sizeof b) != 512) return fail("garbage cut is zero");
  /* only avail bytes are pending: the byte after them is not the next piece, whatever it holds */
  memset(b, 'a', sizeof b);
  b[512] = 0x80;   /* a continuation byte right after the cut */
  k = utf8_cut(b, 512, 513);
  if (k >= 512) return fail("a continuation byte after the cut is not seen");
  k = utf8_cut(b, 512, 512);
  if (k != 512) return fail("the byte after the pending run was read");
  printf("ok\n");
  return 0;
}
