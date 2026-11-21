/* World kernel: storage, tick queues, fluids, fire, placing, breaking,
   falling blocks, items, rays and sight. All coordinates use real Y values
   from -64 to 319. Cells outside the columns read as barrier. */
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "blocks_gen.h"

#define Y_MIN (-64)
#define Y_MAX 319
#define WORLD_H 384
#define WHEEL 128
#define W_BLOCK 0
#define W_FLUID 1
#define UNIFORM 0x80000000u
#define RAWSEC 0x40000000u
#define BASE_MAGIC 0x57524c44u
#define BASE_VERSION 2u
#define FEAT_FLUIDS 1
#define FEAT_FIRE 2
#define MAX_ITEMS 128
#define MAX_FALLING 64
#define SEATS 2
#define NOTABLE_MAX 256
#define HOT_SLOTS 4
#define HOT_AFTER 12
#define EPS 1e-7
#define LOGGED 0x8000
#define PI 3.14159265358979323846

enum { D_DOWN, D_UP, D_NORTH, D_EAST, D_SOUTH, D_WEST };
static const int DX6[6] = {0, 0, 0, 1, 0, -1};
static const int DY6[6] = {-1, 1, 0, 0, 0, 0};
static const int DZ6[6] = {0, 0, -1, 0, 1, 0};
static const int OPP6[6] = {D_UP, D_DOWN, D_SOUTH, D_WEST, D_NORTH, D_EAST};
static const int SX[4] = {0, 1, 0, -1};
static const int SZ[4] = {-1, 0, 1, 0};

/* ---------- Base world ---------- */

typedef struct {
    uint32_t magic, version;
    int32_t nx, nz, sx, sy, sz, pad;
    uint32_t mixed, raws;
    uint64_t bytes;
    int32_t ylo, yhi;
    uint8_t reserved[8];
} BaseHeader;

typedef struct {
    const BaseHeader *h;
    const uint32_t *sec;
    const uint16_t *pal, *raw;
    const uint8_t *idx;
    int nx, nz, sx, sy, sz, ylo, yhi;
    void *owned;
} Base;

static void base_bind(Base *b, const void *blob) {
    const BaseHeader *h = blob;
    const uint8_t *p = (const uint8_t *)blob + sizeof(BaseHeader);
    size_t ns = (size_t)h->sx * h->sy * h->sz;
    b->h = h;
    b->nx = h->nx; b->nz = h->nz; b->sx = h->sx; b->sy = h->sy; b->sz = h->sz;
    b->ylo = h->ylo; b->yhi = h->yhi;
    b->sec = (const uint32_t *)p; p += ns * 4;
    b->pal = (const uint16_t *)p; p += (size_t)h->mixed * 512;
    b->raw = (const uint16_t *)p; p += (size_t)h->raws * 8192;
    b->idx = p;
}

/* Stores the cells from ylo up to but not including yhi, both on section boundaries.
   Cells below the band read as bedrock and cells above it read as air. */
void *base_build(const uint16_t *raw, int nx, int nz, int ylo, int yhi) {
    int sx = (nx + 15) / 16, sz = (nz + 15) / 16, sy = (yhi - ylo) / 16, y_off = ylo - Y_MIN;
    size_t ns = (size_t)sx * sy * sz;
    uint8_t *kind = calloc(ns, 1);
    int32_t *map = malloc(65536 * sizeof(int32_t));
    uint16_t *cell = malloc(4096 * 2), *seen = malloc(4096 * 2);
    uint32_t mixed = 0, raws = 0;
    memset(map, -1, 65536 * sizeof(int32_t));
#define LOAD_SECTION(SX_, SZ_, SY_)                                                     \
    for (int i = 0; i < 4096; i++) {                                                    \
        int x = (SX_) * 16 + (i >> 8), z = (SZ_) * 16 + ((i >> 4) & 15), y = y_off + (SY_) * 16 + (i & 15); \
        cell[i] = (x < nx && z < nz) ? raw[((size_t)x * nz + z) * WORLD_H + y] : (uint16_t)B_AIR;   \
    }
    for (int a = 0; a < sx; a++) for (int c = 0; c < sz; c++) for (int d = 0; d < sy; d++) {
        LOAD_SECTION(a, c, d)
        int np = 0;
        for (int i = 0; i < 4096; i++) if (map[cell[i]] < 0) { map[cell[i]] = np; seen[np++] = cell[i]; }
        for (int i = 0; i < np; i++) map[seen[i]] = -1;
        size_t s = ((size_t)a * sz + c) * sy + d;
        if (np == 1) kind[s] = 0;
        else if (np <= 256) { kind[s] = 1; mixed++; }
        else { kind[s] = 2; raws++; }
    }
    size_t bytes = sizeof(BaseHeader) + ns * 4 + (size_t)mixed * 512 + (size_t)raws * 8192 + (size_t)mixed * 4096;
    uint8_t *blob = calloc(bytes, 1);
    BaseHeader *h = (BaseHeader *)blob;
    h->magic = BASE_MAGIC; h->version = BASE_VERSION;
    h->nx = nx; h->nz = nz; h->sx = sx; h->sy = sy; h->sz = sz;
    h->mixed = mixed; h->raws = raws; h->bytes = bytes;
    h->ylo = ylo; h->yhi = yhi;
    uint32_t *sec = (uint32_t *)(blob + sizeof(BaseHeader));
    uint16_t *pal = (uint16_t *)((uint8_t *)sec + ns * 4);
    uint16_t *rawp = (uint16_t *)((uint8_t *)pal + (size_t)mixed * 512);
    uint8_t *idx = (uint8_t *)rawp + (size_t)raws * 8192;
    uint32_t m = 0, r = 0;
    for (int a = 0; a < sx; a++) for (int c = 0; c < sz; c++) for (int d = 0; d < sy; d++) {
        LOAD_SECTION(a, c, d)
        size_t s = ((size_t)a * sz + c) * sy + d;
        if (kind[s] == 0) { sec[s] = UNIFORM | cell[0]; continue; }
        if (kind[s] == 2) { memcpy(rawp + (size_t)r * 4096, cell, 8192); sec[s] = RAWSEC | r; r++; continue; }
        int np = 0;
        for (int i = 0; i < 4096; i++) {
            if (map[cell[i]] < 0) { map[cell[i]] = np; pal[(size_t)m * 256 + np] = cell[i]; seen[np] = cell[i]; np++; }
            idx[(size_t)m * 4096 + i] = (uint8_t)map[cell[i]];
        }
        for (int i = 0; i < np; i++) map[seen[i]] = -1;
        sec[s] = m++;
    }
#undef LOAD_SECTION
    free(kind); free(map); free(cell); free(seen);
    Base *b = calloc(1, sizeof(Base));
    base_bind(b, blob);
    b->owned = blob;
    return b;
}

/* Wraps a serialized base without copying, for read only memory maps. */
void *base_open(const void *blob, uint64_t size) {
    const BaseHeader *h = blob;
    if (size < sizeof(BaseHeader) || h->magic != BASE_MAGIC || h->version != BASE_VERSION || h->bytes != size) return NULL;
    Base *b = calloc(1, sizeof(Base));
    base_bind(b, blob);
    return b;
}
const void *base_blob(void *p) { return ((Base *)p)->h; }
uint64_t base_bytes(void *p) { return ((Base *)p)->h->bytes; }
uint32_t base_mixed(void *p) { return ((Base *)p)->h->mixed; }
uint32_t base_raws(void *p) { return ((Base *)p)->h->raws; }
int base_nx(void *p) { return ((Base *)p)->nx; }
int base_nz(void *p) { return ((Base *)p)->nz; }
int base_ylo(void *p) { return ((Base *)p)->ylo; }
int base_yhi(void *p) { return ((Base *)p)->yhi; }
void base_free(void *p) { Base *b = p; free(b->owned); free(b); }

static inline size_t sec_index(const Base *b, int x, int yi, int z) {
    return (((size_t)(x >> 4) * b->sz) + (z >> 4)) * b->sy + (yi >> 4);
}
static inline uint16_t base_get(const Base *b, int x, int yi, int z) {
    uint32_t e = b->sec[sec_index(b, x, yi, z)];
    if (e & UNIFORM) return (uint16_t)e;
    uint32_t i = ((uint32_t)(x & 15) << 8) | ((uint32_t)(z & 15) << 4) | (uint32_t)(yi & 15);
    if (e & RAWSEC) return b->raw[(size_t)(e & ~RAWSEC) * 4096 + i];
    return b->pal[(size_t)e * 256 + b->idx[(size_t)e * 4096 + i]];
}

/* ---------- Arena ---------- */

typedef struct {
    double x, y, z, vx, vy, vz;
    int32_t age, delay;
    uint16_t item, count;
    uint8_t ground;
} Item;

typedef struct {
    double x, y, z, vy;
    int32_t age;
    uint16_t cell;
} Falling;

typedef struct {
    int32_t x, y, z;
    uint32_t tick;
    uint8_t kind;
} Notable;

typedef struct {
    uint8_t m[32768];
    int cx, cy, cz, init, phase;
    int nnotable;
    uint8_t line_bits;
    Notable notable[NOTABLE_MAX];
} Mem;

typedef struct {
    int digging, dx, dy, dz;
    double progress;
    int dig_delay, use_cd;
    Mem *mem;
} Seat;

typedef struct Arena {
    const Base *b;
    uint32_t cap, n, *keys, *used;
    uint16_t *vals;
    uint64_t *dirty;
    uint32_t dwords, ns;
    uint8_t *scount;
    uint32_t hot_sec[HOT_SLOTS];
    uint16_t *hot[HOT_SLOTS];
    int hot_n;
    uint32_t pcap, pn, *pkeys, *pdue, *pused;
    uint32_t *wheel[2][WHEEL], wlen[2][WHEEL], wcap[2][WHEEL];
    uint32_t now, pending;
    uint64_t rng, fluid_ticks, block_ticks, sets;
    size_t mem, mem_cap;
    int full, client_model, features;
    Item *items;
    int nitems;
    Falling *falling;
    int nfalling;
    Seat seats[SEATS];
    uint32_t *trace;
    int trace_cap, trace_n;
} Arena;

static inline int mem_ok(Arena *a, size_t extra) {
    if (!a->mem_cap || a->mem + extra <= a->mem_cap) { a->mem += extra; return 1; }
    a->full = 1;
    return 0;
}

void *arena_new(void *base, uint64_t seed, uint64_t mem_cap, int client_model, int features) {
    Arena *a = calloc(1, sizeof(Arena));
    a->b = base;
    a->cap = 256;
    a->keys = calloc(a->cap, 4); a->vals = malloc(a->cap * 2); a->used = malloc(a->cap * 4);
    a->ns = (uint32_t)((size_t)a->b->sx * a->b->sy * a->b->sz);
    a->dwords = (a->ns + 63) / 64;
    a->dirty = calloc(a->dwords, 8);
    a->scount = calloc(a->ns, 1);
    a->pcap = 256;
    a->pkeys = calloc(a->pcap, 4); a->pdue = malloc(a->pcap * 4); a->pused = malloc(a->pcap * 4);
    a->mem = sizeof(Arena) + a->cap * 10 + a->dwords * 8 + a->ns + a->pcap * 12;
    a->mem_cap = mem_cap;
    a->client_model = client_model;
    a->features = features;
    uint64_t z = seed + 0x9E3779B97F4A7C15ull;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    a->rng = (z ^ (z >> 31)) | 1;
    return a;
}

void arena_reset(void *p) {
    Arena *a = p;
    for (uint32_t i = 0; i < a->n; i++) a->keys[a->used[i]] = 0;
    for (uint32_t i = 0; i < a->pn; i++) a->pkeys[a->pused[i]] = 0;
    a->n = a->pn = 0;
    memset(a->dirty, 0, a->dwords * 8);
    memset(a->scount, 0, a->ns);
    memset(a->wlen, 0, sizeof(a->wlen));
    a->pending = 0; a->now = 0; a->hot_n = 0; a->full = 0;
    a->nitems = 0; a->nfalling = 0; a->trace_n = 0;
    for (int s = 0; s < SEATS; s++) {
        Mem *m = a->seats[s].mem;
        memset(&a->seats[s], 0, sizeof(Seat));
        a->seats[s].mem = m;
        if (m) { m->init = 0; m->nnotable = 0; m->phase = 0; }
    }
}

void arena_free(void *p) {
    Arena *a = p;
    free(a->keys); free(a->vals); free(a->used); free(a->dirty); free(a->scount);
    free(a->pkeys); free(a->pdue); free(a->pused);
    for (int w = 0; w < 2; w++) for (int i = 0; i < WHEEL; i++) free(a->wheel[w][i]);
    for (int i = 0; i < HOT_SLOTS; i++) free(a->hot[i]);
    for (int s = 0; s < SEATS; s++) free(a->seats[s].mem);
    free(a->items); free(a->falling); free(a->trace);
    free(a);
}

uint64_t arena_bytes(void *p) { return ((Arena *)p)->mem; }
int arena_full(void *p) { return ((Arena *)p)->full; }
uint32_t arena_edits(void *p) { return ((Arena *)p)->n; }
uint32_t arena_pending(void *p) { return ((Arena *)p)->pending; }
uint32_t arena_now(void *p) { return ((Arena *)p)->now; }
uint64_t arena_fluid_ticks(void *p) { return ((Arena *)p)->fluid_ticks; }
uint64_t arena_block_ticks(void *p) { return ((Arena *)p)->block_ticks; }
uint64_t arena_sets(void *p) { return ((Arena *)p)->sets; }
int arena_hot(void *p) { return ((Arena *)p)->hot_n; }
void arena_seed(void *p, uint64_t s) { ((Arena *)p)->rng = s | 1; }

static inline uint64_t rnd(Arena *a) {
    uint64_t x = a->rng;
    x ^= x << 13; x ^= x >> 7; x ^= x << 17;
    a->rng = x;
    return x;
}
static inline int rnd_below(Arena *a, int n) { return (int)((rnd(a) >> 11) % (uint64_t)n); }
static inline double rnd_unit(Arena *a) { return (double)(rnd(a) >> 11) / 9007199254740992.0; }

static inline uint32_t hash32(uint32_t k) { return k * 2654435761u; }
static inline uint32_t cell_id(const Base *b, int x, int y, int z) {
    return (uint32_t)((((size_t)x * b->nz) + z) * WORLD_H + (y - Y_MIN));
}
static inline void cell_xyz(const Base *b, uint32_t id, int *x, int *y, int *z) {
    uint32_t r = id / WORLD_H;
    *y = (int)(id % WORLD_H) + Y_MIN;
    *z = (int)(r % (uint32_t)b->nz);
    *x = (int)(r / (uint32_t)b->nz);
}
static inline int in_world(const Base *b, int x, int y, int z) {
    return (unsigned)x < (unsigned)b->nx && (unsigned)z < (unsigned)b->nz && y >= b->ylo && y < b->yhi;
}

static inline uint16_t aget(const Arena *a, int x, int y, int z) {
    const Base *b = a->b;
    if ((unsigned)x >= (unsigned)b->nx || (unsigned)z >= (unsigned)b->nz) return B_BARRIER;
    int yi = y - b->ylo;
    if (yi < 0) return B_BEDROCK;
    if (y >= b->yhi) return B_AIR;
    uint32_t s = (uint32_t)sec_index(b, x, yi, z);
    if ((a->dirty[s >> 6] >> (s & 63)) & 1) {
        for (int i = 0; i < a->hot_n; i++)
            if (a->hot_sec[i] == s) return a->hot[i][((x & 15) << 8) | ((z & 15) << 4) | (yi & 15)];
        uint32_t k = cell_id(b, x, y, z) + 1, m = a->cap - 1, h = hash32(k) & m;
        while (a->keys[h]) { if (a->keys[h] == k) return a->vals[h]; h = (h + 1) & m; }
    }
    return base_get(b, x, yi, z);
}

static int grow_overlay(Arena *a) {
    uint32_t oc = a->cap, nc = oc * 2;
    if (!mem_ok(a, (size_t)oc * 10)) return 0;
    uint32_t *nk = calloc(nc, 4), *nu = malloc((size_t)nc * 4);
    uint16_t *nv = malloc((size_t)nc * 2);
    for (uint32_t i = 0; i < a->n; i++) {
        uint32_t o = a->used[i], h = hash32(a->keys[o]) & (nc - 1);
        while (nk[h]) h = (h + 1) & (nc - 1);
        nk[h] = a->keys[o]; nv[h] = a->vals[o]; nu[i] = h;
    }
    free(a->keys); free(a->vals); free(a->used);
    a->keys = nk; a->vals = nv; a->used = nu; a->cap = nc;
    return 1;
}

static void aput(Arena *a, int x, int y, int z, uint16_t v) {
    const Base *b = a->b;
    int yi = y - b->ylo;
    uint32_t sec = (uint32_t)sec_index(b, x, yi, z);
    int ci = ((x & 15) << 8) | ((z & 15) << 4) | (yi & 15);
    for (int i = 0; i < a->hot_n; i++) if (a->hot_sec[i] == sec) { a->hot[i][ci] = v; return; }
    if (a->hot_n < HOT_SLOTS && a->scount[sec] < 255 && ++a->scount[sec] >= HOT_AFTER) {
        int n = a->hot_n;
        if (a->hot[n] || mem_ok(a, 8192)) {
            if (!a->hot[n]) a->hot[n] = malloc(8192);
            int X = x & ~15, Y = yi & ~15, Z = z & ~15;
            for (int i = 0; i < 4096; i++) {
                int cx = X + (i >> 8), cz = Z + ((i >> 4) & 15), cy = Y + (i & 15);
                a->hot[n][i] = (cx < b->nx && cz < b->nz) ? aget(a, cx, cy + b->ylo, cz) : (uint16_t)B_BARRIER;
            }
            a->hot[n][ci] = v;
            a->hot_sec[n] = sec;
            a->hot_n = n + 1;
            a->dirty[sec >> 6] |= 1ull << (sec & 63);
            return;
        }
    }
    if ((a->n + 1) * 2 >= a->cap && !grow_overlay(a)) return;
    uint32_t k = cell_id(b, x, y, z) + 1, m = a->cap - 1, h = hash32(k) & m;
    while (a->keys[h]) { if (a->keys[h] == k) { a->vals[h] = v; return; } h = (h + 1) & m; }
    a->keys[h] = k; a->vals[h] = v; a->used[a->n++] = h;
    a->dirty[sec >> 6] |= 1ull << (sec & 63);
}

/* ---------- Tick queues ---------- */

static int grow_pending(Arena *a) {
    uint32_t oc = a->pcap, nc = oc * 2;
    if (!mem_ok(a, (size_t)oc * 12)) return 0;
    uint32_t *nk = calloc(nc, 4), *nd = malloc((size_t)nc * 4), *nu = malloc((size_t)nc * 4);
    for (uint32_t i = 0; i < a->pn; i++) {
        uint32_t o = a->pused[i], h = hash32(a->pkeys[o]) & (nc - 1);
        while (nk[h]) h = (h + 1) & (nc - 1);
        nk[h] = a->pkeys[o]; nd[h] = a->pdue[o]; nu[i] = h;
    }
    free(a->pkeys); free(a->pdue); free(a->pused);
    a->pkeys = nk; a->pdue = nd; a->pused = nu; a->pcap = nc;
    return 1;
}

/* One pending tick per cell and wheel. A due value of 0 means nothing is pending. */
static void schedule(Arena *a, int wheel, int x, int y, int z, int delay) {
    if (wheel == W_FLUID && !(a->features & FEAT_FLUIDS)) return;
    if (!in_world(a->b, x, y, z)) return;
    if (delay < 1) delay = 1;
    if (delay >= WHEEL) delay = WHEEL - 1;
    if ((a->pn + 1) * 2 >= a->pcap && !grow_pending(a)) return;
    uint32_t cell = cell_id(a->b, x, y, z), k = ((cell << 1) | (uint32_t)wheel) + 1;
    uint32_t m = a->pcap - 1, h = hash32(k) & m;
    while (a->pkeys[h] && a->pkeys[h] != k) h = (h + 1) & m;
    if (a->pkeys[h]) { if (a->pdue[h]) return; }
    else { a->pkeys[h] = k; a->pused[a->pn++] = h; a->pdue[h] = 0; }
    uint32_t due = a->now + (uint32_t)delay, w = due & (WHEEL - 1);
    if (a->wlen[wheel][w] == a->wcap[wheel][w]) {
        uint32_t nc = a->wcap[wheel][w] ? a->wcap[wheel][w] * 2 : 8;
        if (!mem_ok(a, (size_t)(nc - a->wcap[wheel][w]) * 4)) return;
        a->wheel[wheel][w] = realloc(a->wheel[wheel][w], (size_t)nc * 4);
        a->wcap[wheel][w] = nc;
    }
    a->pdue[h] = due;
    a->wheel[wheel][w][a->wlen[wheel][w]++] = cell;
    a->pending++;
}

static inline void clear_pending(Arena *a, int wheel, uint32_t cell) {
    uint32_t k = ((cell << 1) | (uint32_t)wheel) + 1, m = a->pcap - 1, h = hash32(k) & m;
    while (a->pkeys[h] != k) h = (h + 1) & m;
    a->pdue[h] = 0;
    a->pending--;
}

/* ---------- Shapes and faces ---------- */

typedef struct { float lo[3], hi[3]; } Box;

static inline Box mkbox(float x0, float y0, float z0, float x1, float y1, float z1) {
    Box b = {{x0, y0, z0}, {x1, y1, z1}};
    return b;
}
static inline void toward(Box *b, int side) {
    if (side == 0) b->hi[2] = 0.5f;
    else if (side == 1) b->lo[0] = 0.5f;
    else if (side == 2) b->lo[2] = 0.5f;
    else b->hi[0] = 0.5f;
}
static inline Box panel(int side, float t) {
    switch (side) {
        case 0: return mkbox(0, 0, 0, 1, 1, t);
        case 1: return mkbox(1 - t, 0, 0, 1, 1, 1);
        case 2: return mkbox(0, 0, 1 - t, 1, 1, 1);
        default: return mkbox(0, 0, 0, t, 1, 1);
    }
}
static inline int door_side(int st) {
    int f = st & 3, open = (st >> 2) & 1, hinge = (st >> 3) & 1;
    if (!open) return (f + 2) & 3;
    return hinge ? (f + 1) & 3 : (f + 3) & 3;
}
static int stair_boxes(int st, Box *out) {
    int f = st & 3, up = (st >> 2) & 1, shape = (st >> 3) & 7;
    float by0 = up ? 0.5f : 0.0f, by1 = up ? 1.0f : 0.5f;
    float uy0 = up ? 0.0f : 0.5f, uy1 = up ? 0.5f : 1.0f;
    out[0] = mkbox(0, by0, 0, 1, by1, 1);
    Box q = mkbox(0, uy0, 0, 1, uy1, 1);
    if (shape == 3 || shape == 4) {
        toward(&q, f);
        toward(&q, shape == 3 ? (f + 3) & 3 : (f + 1) & 3);
        out[1] = q;
        return 2;
    }
    toward(&q, f);
    out[1] = q;
    if (shape == 1 || shape == 2) {
        Box r = mkbox(0, uy0, 0, 1, uy1, 1);
        toward(&r, (f + 2) & 3);
        toward(&r, shape == 1 ? (f + 3) & 3 : (f + 1) & 3);
        out[2] = r;
        return 3;
    }
    return 2;
}

static int coll_boxes(uint16_t c, Box *out) {
    int id = c & 0xFF, st = c >> 8;
    switch (SHAPE[id]) {
        case SH_FULL: out[0] = mkbox(0, 0, 0, 1, 1, 1); return 1;
        case SH_SLAB:
            if ((st & 3) == 0) out[0] = mkbox(0, 0, 0, 1, 0.5f, 1);
            else if ((st & 3) == 1) out[0] = mkbox(0, 0.5f, 0, 1, 1, 1);
            else out[0] = mkbox(0, 0, 0, 1, 1, 1);
            return 1;
        case SH_STAIRS: return stair_boxes(st, out);
        case SH_DOOR: out[0] = panel(door_side(st), 3.0f / 16.0f); return 1;
        case SH_LADDER: out[0] = panel(((st & 3) + 2) & 3, 3.0f / 16.0f); return 1;
        default: return 0;
    }
}

static int target_boxes(uint16_t c, Box *out) {
    int id = c & 0xFF, st = c >> 8;
    switch (SHAPE[id]) {
        case SH_EMPTY: return 0;
        case SH_WEB: out[0] = mkbox(0, 0, 0, 1, 1, 1); return 1;
        case SH_FIRE: out[0] = mkbox(0, 0, 0, 1, 1.0f / 16.0f, 1); return 1;
        case SH_TORCH: {
            int at = st & 7;
            const float w = 5.0f / 32.0f, d = 5.0f / 16.0f;
            if (at == 0) { out[0] = mkbox(0.5f - w, 0, 0.5f - w, 0.5f + w, 0.625f, 0.5f + w); return 1; }
            int back = (at - 1 + 2) & 3;
            float y0 = 3.0f / 16.0f, y1 = 13.0f / 16.0f;
            if (back == 0) out[0] = mkbox(0.5f - w, y0, 0, 0.5f + w, y1, d);
            else if (back == 1) out[0] = mkbox(1 - d, y0, 0.5f - w, 1, y1, 0.5f + w);
            else if (back == 2) out[0] = mkbox(0.5f - w, y0, 1 - d, 0.5f + w, y1, 1);
            else out[0] = mkbox(0, y0, 0.5f - w, d, y1, 0.5f + w);
            return 1;
        }
        default: return coll_boxes(c, out);
    }
}

/* Six bit mask of faces fully covered by the shape, indexed by D_DOWN to D_WEST. */
static int partial_face_mask(uint16_t c) {
    int id = c & 0xFF, st = c >> 8;
    switch (SHAPE[id]) {
        case SH_SLAB: {
            int t = st & 3;
            return t == 0 ? 1 << D_DOWN : t == 1 ? 1 << D_UP : 0x3F;
        }
        case SH_STAIRS: {
            int f = st & 3, up = (st >> 2) & 1, shape = (st >> 3) & 7;
            int mask = 1 << (up ? D_UP : D_DOWN);
            if (shape <= 2) mask |= 1 << (D_NORTH + f);
            if (shape == 1) mask |= 1 << (D_NORTH + ((f + 3) & 3));
            if (shape == 2) mask |= 1 << (D_NORTH + ((f + 1) & 3));
            return mask;
        }
        case SH_DOOR: return 1 << (D_NORTH + door_side(st));
        case SH_LADDER: return 1 << (D_NORTH + (((st & 3) + 2) & 3));
        default: return 0;
    }
}
static inline int face_mask(uint16_t c) {
    int shape = SHAPE[c & 0xFF];
    if (shape == SH_EMPTY) return 0;
    return shape == SH_FULL ? 0x3F : partial_face_mask(c);
}
static inline int face_open(uint16_t from, uint16_t to, int dir) {
    return !((face_mask(from) >> dir) & 1) && !((face_mask(to) >> OPP6[dir]) & 1);
}

/* ---------- Fluid state helpers ---------- */

static inline int logged(uint16_t c) { return (c & LOGGED) && (FLAGS[c & 0xFF] & F_WATERLOG); }
static inline int fkind(uint16_t c) {
    int id = c & 0xFF;
    if (id == B_WATER || id == B_LAVA) return id;
    return logged(c) ? B_WATER : 0;
}
static inline int famt(uint16_t c) {
    int id = c & 0xFF;
    if (id == B_WATER || id == B_LAVA) return (c >> 8) & 15;
    return logged(c) ? 8 : 0;
}
static inline int ffall(uint16_t c) {
    int id = c & 0xFF;
    return (id == B_WATER || id == B_LAVA) ? (c >> 12) & 1 : 0;
}
static inline int fsrc(uint16_t c) { return fkind(c) && famt(c) == 8 && !ffall(c); }
static inline uint16_t mk_fluid(int k, int amount, int falling) {
    return (uint16_t)(k | (amount << 8) | (falling << 12));
}
static inline int fdelay(int k) { return k == B_WATER ? 5 : 30; }
static inline int fdrop(int k) { return k == B_WATER ? 1 : 2; }
static inline int fsearch(int k) { return k == B_WATER ? 4 : 2; }

/* ---------- Writing a cell ---------- */

static void set_cell(Arena *a, int x, int y, int z, uint16_t nw);
static void spawn_item(Arena *a, double x, double y, double z, int item, int count, int delay,
                       double vx, double vy, double vz);
static void pop_drop(Arena *a, int x, int y, int z, uint16_t c);

static inline int is_stairs(uint16_t c) { return SHAPE[c & 0xFF] == SH_STAIRS; }
static inline int needs_support(uint16_t c) {
    int s = SHAPE[c & 0xFF];
    return s == SH_TORCH || s == SH_LADDER || s == SH_DOOR;
}
static inline int solid_top(uint16_t c) { return (face_mask(c) >> D_UP) & 1; }

static int lava_wet(const Arena *a, int x, int y, int z) {
    if (fkind(aget(a, x, y + 1, z)) == B_WATER) return 1;
    for (int d = 0; d < 4; d++)
        if (fkind(aget(a, x + SX[d], y, z + SZ[d])) == B_WATER) return 1;
    return 0;
}

static inline int ignite_of(uint16_t c) { return logged(c) ? 0 : IGNITE[c & 0xFF]; }
static inline int burn_of(uint16_t c) { return logged(c) ? 0 : BURN[c & 0xFF]; }

static int flammable_near(const Arena *a, int x, int y, int z) {
    for (int i = 0; i < 6; i++)
        if (ignite_of(aget(a, x + DX6[i], y + DY6[i], z + DZ6[i])) > 0) return 1;
    return 0;
}
static int fire_can_live(const Arena *a, int x, int y, int z) {
    return solid_top(aget(a, x, y - 1, z)) || flammable_near(a, x, y, z);
}

static int can_take_stair_shape(const Arena *a, int x, int y, int z, int f, int up, int side) {
    uint16_t n = aget(a, x + SX[side], y, z + SZ[side]);
    if (!is_stairs(n)) return 1;
    int st = n >> 8;
    return (st & 3) != f || ((st >> 2) & 1) != up;
}
static int stair_shape(const Arena *a, int x, int y, int z, uint16_t c) {
    int st = c >> 8, f = st & 3, up = (st >> 2) & 1;
    uint16_t front = aget(a, x + SX[f], y, z + SZ[f]);
    if (is_stairs(front) && ((front >> 10) & 1) == up) {
        int g = (front >> 8) & 3;
        if ((g & 1) != (f & 1) && can_take_stair_shape(a, x, y, z, f, up, (g + 2) & 3))
            return g == ((f + 3) & 3) ? 3 : 4;
    }
    uint16_t back = aget(a, x - SX[f], y, z - SZ[f]);
    if (is_stairs(back) && ((back >> 10) & 1) == up) {
        int g = (back >> 8) & 3;
        if ((g & 1) != (f & 1) && can_take_stair_shape(a, x, y, z, f, up, g))
            return g == ((f + 3) & 3) ? 1 : 2;
    }
    return 0;
}
static inline uint16_t with_stair_shape(uint16_t c, int shape) {
    return (uint16_t)((c & ~(7 << 11)) | (shape << 11));
}

static void set_cell(Arena *a, int x, int y, int z, uint16_t nw) {
    if (!in_world(a->b, x, y, z)) return;
    if (!(a->features & FEAT_FLUIDS)) {
        if ((nw & 0xFF) == B_WATER || (nw & 0xFF) == B_LAVA) return;
        if (logged(nw)) nw = (uint16_t)(nw & ~LOGGED);
    }
    if ((nw & 0xFF) == B_FIRE && !(a->features & FEAT_FIRE)) return;
    uint16_t old = aget(a, x, y, z);
    if (old == nw) return;
    aput(a, x, y, z, nw);
    a->sets++;
    int id = nw & 0xFF;
    if (id == B_LAVA && lava_wet(a, x, y, z)) {
        set_cell(a, x, y, z, fsrc(nw) ? (uint16_t)B_OBSIDIAN : (uint16_t)B_COBBLESTONE);
        return;
    }
    int k = fkind(nw);
    if (k) schedule(a, W_FLUID, x, y, z, fdelay(k));
    if (FLAGS[id] & F_FALLS) schedule(a, W_BLOCK, x, y, z, 2);
    if (needs_support(nw)) schedule(a, W_BLOCK, x, y, z, 1);
    if (id == B_FIRE) schedule(a, W_BLOCK, x, y, z, 30 + rnd_below(a, 10));
    for (int i = 0; i < 6; i++) {
        int jx = x + DX6[i], jy = y + DY6[i], jz = z + DZ6[i];
        if (!in_world(a->b, jx, jy, jz)) continue;
        uint16_t n = aget(a, jx, jy, jz);
        int nid = n & 0xFF;
        if (nid == B_AIR) continue;
        if (nid == B_LAVA && lava_wet(a, jx, jy, jz)) {
            set_cell(a, jx, jy, jz, fsrc(n) ? (uint16_t)B_OBSIDIAN : (uint16_t)B_COBBLESTONE);
            continue;
        }
        int nk = fkind(n);
        if (nk) schedule(a, W_FLUID, jx, jy, jz, fdelay(nk));
        if (FLAGS[nid] & F_FALLS) schedule(a, W_BLOCK, jx, jy, jz, 2);
        if (needs_support(n)) schedule(a, W_BLOCK, jx, jy, jz, 1);
        if (nid == B_FIRE && !fire_can_live(a, jx, jy, jz)) { set_cell(a, jx, jy, jz, B_AIR); continue; }
        if (is_stairs(n) && i >= D_NORTH) {
            int sh = stair_shape(a, jx, jy, jz, n);
            if (sh != ((n >> 11) & 7)) set_cell(a, jx, jy, jz, with_stair_shape(n, sh));
        }
    }
}

/* ---------- Fluids ---------- */

static inline int cell_holds(uint16_t c, int k) {
    int id = c & 0xFF;
    if (id == B_AIR) return 1;
    if (id == B_WATER || id == B_LAVA) return id == k ? !fsrc(c) : 1;
    int shape = SHAPE[id];
    if (shape == SH_DOOR || shape == SH_LADDER) return 0;
    int f = FLAGS[id];
    if (f & F_WASH) return 1;
    return (f & F_REPLACEABLE) && !(f & F_SOLID);
}

static uint16_t new_state(const Arena *a, int x, int y, int z, int k) {
    uint16_t c = aget(a, x, y, z);
    int best = 0, sources = 0;
    for (int d = 0; d < 4; d++) {
        uint16_t n = aget(a, x + SX[d], y, z + SZ[d]);
        if (fkind(n) != k || !face_open(c, n, D_NORTH + d)) continue;
        if (fsrc(n)) sources++;
        if (famt(n) > best) best = famt(n);
    }
    if (k == B_WATER && sources >= 2) {
        uint16_t below = aget(a, x, y - 1, z);
        if ((FLAGS[below & 0xFF] & F_SOLID) || (fkind(below) == B_WATER && fsrc(below))) return mk_fluid(k, 8, 0);
    }
    uint16_t above = aget(a, x, y + 1, z);
    if (fkind(above) == k && face_open(c, above, D_UP)) return mk_fluid(k, 8, 1);
    int amount = best - fdrop(k);
    return amount > 0 ? mk_fluid(k, amount, 0) : (uint16_t)B_AIR;
}

static int is_hole(const Arena *a, int x, int y, int z, int k) {
    uint16_t c = aget(a, x, y, z), b = aget(a, x, y - 1, z);
    if (!face_open(c, b, D_DOWN)) return 0;
    return fkind(b) == k || cell_holds(b, k);
}

static int replace_ok(const Arena *a, int x, int y, int z, int k, int down) {
    uint16_t c = aget(a, x, y, z);
    int id = c & 0xFF;
    if ((id != B_WATER && id != B_LAVA) || id == k) return 1;
    if (id == B_WATER) return down && k == B_LAVA;
    return famt(c) >= 4 || (aget(a, x, y + 1, z) & 0xFF) == B_LAVA;
}

/* Cells near one spread decision, read once because nothing changes while targets are chosen. */
typedef struct {
    const Arena *a;
    int x0, y, z0, k;
    uint8_t f[13][13];
    uint16_t v[13][13];
} Ctx;

static inline uint8_t ctx_flags(Ctx *c, int x, int z) {
    int i = x - c->x0, j = z - c->z0;
    uint8_t *f = &c->f[i][j];
    if (!*f) {
        c->v[i][j] = aget(c->a, x, c->y, z);
        *f = 1;
        if (cell_holds(c->v[i][j], c->k)) {
            *f |= 2;
            if (is_hole(c->a, x, c->y, z, c->k)) *f |= 4;
        }
    }
    return *f;
}
static inline uint16_t ctx_cell(Ctx *c, int x, int z) {
    ctx_flags(c, x, z);
    return c->v[x - c->x0][z - c->z0];
}

/* Steps from a side cell to the nearest hole, up to the limit, without stepping straight back.
   Returns 1000 when no hole is in range. */
static int search(Ctx *c, int x, int z, int from, int limit) {
    uint16_t seen[13] = {0};
    int8_t qx[64], qz[64], qd[64];
    int head = 0, tail = 1;
    qx[0] = (int8_t)(x - c->x0); qz[0] = (int8_t)(z - c->z0); qd[0] = 0;
    seen[qx[0]] |= (uint16_t)(1u << qz[0]);
    while (head < tail) {
        int i = qx[head], j = qz[head], depth = qd[head];
        int first = head == 0;
        head++;
        uint16_t here = ctx_cell(c, i + c->x0, j + c->z0);
        for (int d = 0; d < 4; d++) {
            if (first && d == from) continue;
            int ni = i + SX[d], nj = j + SZ[d];
            if ((seen[ni] >> nj) & 1) continue;
            uint8_t f = ctx_flags(c, ni + c->x0, nj + c->z0);
            if (!(f & 2) || !face_open(here, c->v[ni][nj], D_NORTH + d)) continue;
            if (f & 4) return depth + 1;
            seen[ni] |= (uint16_t)(1u << nj);
            if (depth + 1 < limit) { qx[tail] = (int8_t)ni; qz[tail] = (int8_t)nj; qd[tail] = (int8_t)(depth + 1); tail++; }
        }
    }
    return 1000;
}

static void spread_to(Arena *a, int x, int y, int z, int k, uint16_t next, int down) {
    uint16_t cur = aget(a, x, y, z);
    int id = cur & 0xFF;
    if (k == B_LAVA && down && id == B_WATER) { set_cell(a, x, y, z, B_STONE); return; }
    if (!fkind(next)) return;
    if ((FLAGS[id] & F_WASH) && id != B_FIRE && k == B_WATER) pop_drop(a, x, y, z, cur);
    set_cell(a, x, y, z, next);
}

static void spread_sideways(Arena *a, int x, int y, int z, uint16_t c) {
    int k = fkind(c), give = ffall(c) ? 7 : famt(c) - fdrop(k);
    if (give <= 0) return;
    Ctx ctx;
    ctx.a = a; ctx.x0 = x - 6; ctx.y = y; ctx.z0 = z - 6; ctx.k = k;
    memset(ctx.f, 0, sizeof(ctx.f));
    int best = 1000, nt = 0, td[4];
    uint16_t ts[4];
    int limit = fsearch(k);
    for (int d = 0; d < 4; d++) {
        int jx = x + SX[d], jz = z + SZ[d];
        uint8_t f = ctx_flags(&ctx, jx, jz);
        if (!(f & 2) || !face_open(c, ctx.v[jx - ctx.x0][jz - ctx.z0], D_NORTH + d)) continue;
        uint16_t next = new_state(a, jx, y, jz, k);
        if (!fkind(next)) continue;
        int dist = (f & 4) ? 0 : search(&ctx, jx, jz, (d + 2) & 3, limit);
        if (dist < best) nt = 0;
        if (dist <= best) {
            if (replace_ok(a, jx, y, jz, k, 0)) { td[nt] = d; ts[nt] = next; nt++; }
            best = dist;
        }
    }
    for (int t = 0; t < nt; t++) spread_to(a, x + SX[td[t]], y, z + SZ[td[t]], k, ts[t], 0);
}

static void fluid_tick(Arena *a, int x, int y, int z) {
    uint16_t c = aget(a, x, y, z);
    int k = fkind(c);
    if (!k) return;
    a->fluid_ticks++;
    if (!fsrc(c)) {
        uint16_t next = new_state(a, x, y, z, k);
        if (!fkind(next)) { set_cell(a, x, y, z, B_AIR); return; }
        if (next != c) {
            set_cell(a, x, y, z, next);
            c = aget(a, x, y, z);
            if (fkind(c) != k) return;
        }
    }
    uint16_t below = aget(a, x, y - 1, z);
    if (y > Y_MIN && face_open(c, below, D_DOWN) && cell_holds(below, k) && replace_ok(a, x, y - 1, z, k, 1)) {
        spread_to(a, x, y - 1, z, k, new_state(a, x, y - 1, z, k), 1);
        int n = 0;
        for (int d = 0; d < 4; d++) if (fsrc(aget(a, x + SX[d], y, z + SZ[d])) && fkind(aget(a, x + SX[d], y, z + SZ[d])) == k) n++;
        if (n >= 3) spread_sideways(a, x, y, z, c);
        return;
    }
    if (fsrc(c) || !is_hole(a, x, y, z, k)) spread_sideways(a, x, y, z, c);
}

/* Flow direction of a fluid cell. Model 0 is vanilla and model 1 reverses the ledge test. */
static void flow_vector(const Arena *a, int x, int y, int z, double *out) {
    uint16_t c = aget(a, x, y, z);
    int k = fkind(c);
    out[0] = out[1] = out[2] = 0;
    if (!k) return;
    double own = famt(c) / 9.0, fx = 0, fz = 0;
    for (int d = 0; d < 4; d++) {
        uint16_t n = aget(a, x + SX[d], y, z + SZ[d]);
        int nk = fkind(n);
        if (nk && nk != k) continue;
        double h = nk ? famt(n) / 9.0 : 0.0, push = 0.0;
        if (h == 0.0) {
            int blocks = (FLAGS[n & 0xFF] & F_SOLID) != 0;
            if (a->client_model ? blocks : !blocks) {
                uint16_t lower = aget(a, x + SX[d], y - 1, z + SZ[d]);
                if (fkind(lower) == k && famt(lower) > 0) push = own - (famt(lower) / 9.0 - 8.0 / 9.0);
            }
        } else {
            push = own - h;
        }
        fx += SX[d] * push;
        fz += SZ[d] * push;
    }
    double fy = 0;
    if (ffall(c)) {
        for (int d = 0; d < 4; d++) {
            uint16_t side = aget(a, x + SX[d], y, z + SZ[d]);
            uint16_t upper = aget(a, x + SX[d], y + 1, z + SZ[d]);
            int toward_us = D_NORTH + ((d + 2) & 3);
            if (((face_mask(side) >> toward_us) & 1) || ((face_mask(upper) >> toward_us) & 1)) {
                double l = sqrt(fx * fx + fz * fz);
                if (l > 0) { fx /= l; fz /= l; }
                fy = -6.0;
                break;
            }
        }
    }
    double l = sqrt(fx * fx + fy * fy + fz * fz);
    if (l > 0) { out[0] = fx / l; out[1] = fy / l; out[2] = fz / l; }
}

/* Height of the fluid surface in a cell, from 0 to 1. */
static inline double fluid_height(const Arena *a, int x, int y, int z, uint16_t c) {
    int k = fkind(c);
    if (!k) return 0.0;
    if (fkind(aget(a, x, y + 1, z)) == k) return 1.0;
    return famt(c) / 9.0;
}

/* ---------- Fire ---------- */

#define FIRE_DIFFICULTY 2

static void burn_check(Arena *a, int x, int y, int z, int chance, int age) {
    uint16_t c = aget(a, x, y, z);
    int odds = burn_of(c);
    if (odds <= 0 || rnd_below(a, chance) >= odds) return;
    if (rnd_below(a, age + 10) < 5) {
        int na = age + rnd_below(a, 5) / 4;
        if (na > 15) na = 15;
        set_cell(a, x, y, z, (uint16_t)(B_FIRE | (na << 8)));
    } else {
        set_cell(a, x, y, z, B_AIR);
    }
}

static int ignite_odds(const Arena *a, int x, int y, int z) {
    if ((aget(a, x, y, z) & 0xFF) != B_AIR) return 0;
    int best = 0;
    for (int i = 0; i < 6; i++) {
        int v = ignite_of(aget(a, x + DX6[i], y + DY6[i], z + DZ6[i]));
        if (v > best) best = v;
    }
    return best;
}

static void fire_tick(Arena *a, int x, int y, int z, uint16_t c) {
    schedule(a, W_BLOCK, x, y, z, 30 + rnd_below(a, 10));
    if (!fire_can_live(a, x, y, z)) { set_cell(a, x, y, z, B_AIR); return; }
    int age = (c >> 8) & 15, na = age + rnd_below(a, 3) / 2;
    if (na > 15) na = 15;
    if (na != age) set_cell(a, x, y, z, (uint16_t)(B_FIRE | (na << 8)));
    uint16_t below = aget(a, x, y - 1, z);
    if (!flammable_near(a, x, y, z)) {
        if (!solid_top(below) || age > 3) set_cell(a, x, y, z, B_AIR);
        return;
    }
    if (age == 15 && rnd_below(a, 4) == 0 && ignite_of(below) == 0) { set_cell(a, x, y, z, B_AIR); return; }
    burn_check(a, x + 1, y, z, 300, age);
    burn_check(a, x - 1, y, z, 300, age);
    burn_check(a, x, y - 1, z, 250, age);
    burn_check(a, x, y + 1, z, 250, age);
    burn_check(a, x, y, z - 1, 300, age);
    burn_check(a, x, y, z + 1, 300, age);
    for (int dx = -1; dx <= 1; dx++) for (int dz = -1; dz <= 1; dz++) for (int dy = -1; dy <= 4; dy++) {
        if (!dx && !dy && !dz) continue;
        int jx = x + dx, jy = y + dy, jz = z + dz;
        if (!in_world(a->b, jx, jy, jz)) continue;
        int odds = ignite_odds(a, jx, jy, jz);
        if (odds <= 0) continue;
        int base = dy > 1 ? 100 + (dy - 1) * 100 : 100;
        int degree = (odds + 40 + 7 * FIRE_DIFFICULTY) / (age + 30);
        if (degree > 0 && rnd_below(a, base) < degree) {
            int fa = age + rnd_below(a, 5) / 4;
            if (fa > 15) fa = 15;
            set_cell(a, jx, jy, jz, (uint16_t)(B_FIRE | (fa << 8)));
        }
    }
}

/* ---------- Collision ---------- */

typedef struct { double lo[3], hi[3]; } AABB;

static inline int ifloor(double v) {
    int i = (int)v;
    return (double)i > v ? i - 1 : i;
}
static inline void shift(AABB *b, int axis, double d) { b->lo[axis] += d; b->hi[axis] += d; }

/* Longest move along one axis, up to d, that the box can make without entering a shape. */
static double clip_axis(const Arena *a, const AABB *b, int axis, double d) {
    if (d == 0.0) return 0.0;
    double lo[3], hi[3];
    for (int i = 0; i < 3; i++) { lo[i] = b->lo[i] + EPS; hi[i] = b->hi[i] - EPS; }
    if (d < 0) lo[axis] = b->lo[axis] + d - EPS;
    else hi[axis] = b->hi[axis] + d + EPS;
    if (d < 0) hi[axis] = b->lo[axis] + EPS;
    else lo[axis] = b->hi[axis] - EPS;
    int x0 = ifloor(lo[0]), x1 = ifloor(hi[0]), y0 = ifloor(lo[1]), y1 = ifloor(hi[1]), z0 = ifloor(lo[2]), z1 = ifloor(hi[2]);
    int u = (axis + 1) % 3, v = (axis + 2) % 3;
    Box boxes[3];
    for (int x = x0; x <= x1; x++) for (int z = z0; z <= z1; z++) for (int y = y0; y <= y1; y++) {
        uint16_t c = aget(a, x, y, z);
        int shape = SHAPE[c & 0xFF];
        if (shape == SH_EMPTY) continue;
        int n = coll_boxes(c, boxes);
        double cell[3] = {x, y, z};
        for (int i = 0; i < n; i++) {
            double mn[3], mx[3];
            for (int k = 0; k < 3; k++) { mn[k] = cell[k] + boxes[i].lo[k]; mx[k] = cell[k] + boxes[i].hi[k]; }
            if (b->hi[u] <= mn[u] + EPS || b->lo[u] >= mx[u] - EPS) continue;
            if (b->hi[v] <= mn[v] + EPS || b->lo[v] >= mx[v] - EPS) continue;
            if (d > 0) {
                if (b->hi[axis] <= mn[axis] + EPS) {
                    double gap = mn[axis] - b->hi[axis];
                    if (gap < 0) gap = 0;
                    if (gap < d) d = gap;
                }
            } else if (b->lo[axis] >= mx[axis] - EPS) {
                double gap = mx[axis] - b->lo[axis];
                if (gap > 0) gap = 0;
                if (gap > d) d = gap;
            }
        }
    }
    return d;
}

static void sweep(const Arena *a, AABB *b, const double *d, double *moved) {
    moved[1] = clip_axis(a, b, 1, d[1]);
    shift(b, 1, moved[1]);
    int first = (!a->client_model && fabs(d[0]) < fabs(d[2])) ? 2 : 0, second = 2 - first;
    moved[first] = clip_axis(a, b, first, d[first]);
    shift(b, first, moved[first]);
    moved[second] = clip_axis(a, b, second, d[second]);
    shift(b, second, moved[second]);
}

static inline AABB body_box(const double *pos, double w, double h) {
    AABB b;
    b.lo[0] = pos[0] - w / 2; b.lo[1] = pos[1]; b.lo[2] = pos[2] - w / 2;
    b.hi[0] = pos[0] + w / 2; b.hi[1] = pos[1] + h; b.hi[2] = pos[2] + w / 2;
    return b;
}

static void collide_one(const Arena *a, const double *pos, double w, double h, const double *d,
                        int was_ground, double step, double *out, uint8_t *contact, uint8_t *ground) {
    AABB b = body_box(pos, w, h);
    double m[3];
    sweep(a, &b, d, m);
    int blocked = m[0] != d[0] || m[2] != d[2];
    int landing = d[1] < 0 && m[1] != d[1];
    if (step > 0 && blocked && (was_ground || landing)) {
        AABB r = body_box(pos, w, h);
        double up = clip_axis(a, &r, 1, step), s[3] = {0, up, 0};
        shift(&r, 1, up);
        int first = (!a->client_model && fabs(d[0]) < fabs(d[2])) ? 2 : 0, second = 2 - first;
        s[first] = clip_axis(a, &r, first, d[first]);
        shift(&r, first, s[first]);
        s[second] = clip_axis(a, &r, second, d[second]);
        shift(&r, second, s[second]);
        double settle = clip_axis(a, &r, 1, -up + (d[1] < 0 ? d[1] : 0));
        shift(&r, 1, settle);
        s[1] = up + settle;
        if (s[0] * s[0] + s[2] * s[2] > m[0] * m[0] + m[2] * m[2] + 1e-12) {
            m[0] = s[0]; m[1] = s[1]; m[2] = s[2];
            landing = 1;
        }
    }
    out[0] = pos[0] + m[0]; out[1] = pos[1] + m[1]; out[2] = pos[2] + m[2];
    *contact = (uint8_t)((m[0] != d[0]) | ((m[1] != d[1]) << 1) | ((m[2] != d[2]) << 2));
    *ground = (uint8_t)(landing != 0);
}

void collide_many(void **arenas, int n, int seats, const double *pos, const double *width, const double *height,
                  const double *delta, const uint8_t *was_ground, double step, double *out, uint8_t *contact,
                  uint8_t *ground) {
    for (int i = 0; i < n; i++) for (int s = 0; s < seats; s++) {
        int k = i * seats + s;
        collide_one(arenas[i], pos + 3 * k, width[k], height[k], delta + 3 * k, was_ground ? was_ground[k] : 0,
                    step, out + 3 * k, contact + k, ground + k);
    }
}

/* Flags: 1 in water, 2 in lava, 4 eye in water, 8 eye in lava. Depth and count hold water then lava.
   Flow holds the summed water direction then the summed lava direction. */
void fluid_box_many(void **arenas, int n, int seats, const double *pos, const double *width, const double *height,
                    const double *eye_height, uint8_t *flags, double *depth, double *flow, int32_t *count) {
    for (int i = 0; i < n; i++) for (int s = 0; s < seats; s++) {
        int k = i * seats + s;
        const Arena *a = arenas[i];
        if (!(a->features & FEAT_FLUIDS)) {
            flags[k] = 0;
            depth[2 * k] = depth[2 * k + 1] = 0;
            count[2 * k] = count[2 * k + 1] = 0;
            for (int j = 0; j < 6; j++) flow[6 * k + j] = 0;
            continue;
        }
        AABB b = body_box(pos + 3 * k, width[k], height[k]);
        double lo_y = b.lo[1] + 0.001;
        int x0 = ifloor(b.lo[0] + 0.001), x1 = ifloor(b.hi[0] - 0.001), y0 = ifloor(lo_y), y1 = ifloor(b.hi[1] - 0.001);
        int z0 = ifloor(b.lo[2] + 0.001), z1 = ifloor(b.hi[2] - 0.001);
        uint8_t f = 0;
        double dw = 0, dl = 0, sum[6] = {0, 0, 0, 0, 0, 0};
        int cw = 0, cl = 0;
        for (int x = x0; x <= x1; x++) for (int y = y0; y <= y1; y++) for (int z = z0; z <= z1; z++) {
            uint16_t c = aget(a, x, y, z);
            int kind = fkind(c);
            if (!kind) continue;
            double top = y + fluid_height(a, x, y, z, c);
            if (top < lo_y) continue;
            double v[3];
            flow_vector(a, x, y, z, v);
            /* A current weakens in proportion to the deepest fluid found so far, below 0.4. */
            if (kind == B_WATER) {
                f |= 1; cw++;
                if (top - lo_y > dw) dw = top - lo_y;
                double scale = dw < 0.4 ? dw : 1.0;
                sum[0] += v[0] * scale; sum[1] += v[1] * scale; sum[2] += v[2] * scale;
            } else {
                f |= 2; cl++;
                if (top - lo_y > dl) dl = top - lo_y;
                double scale = dl < 0.4 ? dl : 1.0;
                sum[3] += v[0] * scale; sum[4] += v[1] * scale; sum[5] += v[2] * scale;
            }
        }
        double ey = pos[3 * k + 1] + eye_height[k];
        int ex = ifloor(pos[3 * k]), eyi = ifloor(ey), ez = ifloor(pos[3 * k + 2]);
        uint16_t ec = aget(a, ex, eyi, ez);
        int ek = fkind(ec);
        if (ek && ey < eyi + fluid_height(a, ex, eyi, ez, ec)) f |= ek == B_WATER ? 4 : 8;
        flags[k] = f;
        depth[2 * k] = dw; depth[2 * k + 1] = dl;
        count[2 * k] = cw; count[2 * k + 1] = cl;
        for (int j = 0; j < 6; j++) flow[6 * k + j] = sum[j];
    }
}

/* Flags: 1 in cobweb, 2 in fire, 4 on a ladder at the feet. */
void contact_many(void **arenas, int n, int seats, const double *pos, const double *width, const double *height,
                  uint8_t *flags) {
    for (int i = 0; i < n; i++) for (int s = 0; s < seats; s++) {
        int k = i * seats + s;
        const Arena *a = arenas[i];
        AABB b = body_box(pos + 3 * k, width[k], height[k]);
        int x0 = ifloor(b.lo[0] + 0.001), x1 = ifloor(b.hi[0] - 0.001), y0 = ifloor(b.lo[1] + 0.001), y1 = ifloor(b.hi[1] - 0.001);
        int z0 = ifloor(b.lo[2] + 0.001), z1 = ifloor(b.hi[2] - 0.001);
        uint8_t f = 0;
        for (int x = x0; x <= x1; x++) for (int z = z0; z <= z1; z++) for (int y = y0; y <= y1; y++) {
            int id = aget(a, x, y, z) & 0xFF;
            if (id == B_COBWEB) f |= 1;
            else if (id == B_FIRE) f |= 2;
        }
        int fx = ifloor(pos[3 * k]), fy = ifloor(pos[3 * k + 1] + 1e-6), fz = ifloor(pos[3 * k + 2]);
        if ((aget(a, fx, fy, fz) & 0xFF) == B_LADDER) f |= 4;
        flags[k] = f;
    }
}

/* ---------- Rays ---------- */

typedef struct { int hit, x, y, z, face; double t; } Hit;

static int ray_box_entry(const double *o, const double *d, const Box *bx, int cx, int cy, int cz, double max_t,
                         double *out_t, int *out_face) {
    static const int NEG[3] = {D_EAST, D_UP, D_SOUTH}, POS[3] = {D_WEST, D_DOWN, D_NORTH};
    double t0 = -1e30, t1 = max_t;
    int face = -1, cell[3] = {cx, cy, cz};
    for (int i = 0; i < 3; i++) {
        double lo = cell[i] + (double)bx->lo[i], hi = cell[i] + (double)bx->hi[i];
        if (fabs(d[i]) < 1e-12) {
            if (o[i] < lo || o[i] > hi) return 0;
            continue;
        }
        double ta = (lo - o[i]) / d[i], tb = (hi - o[i]) / d[i];
        int f = d[i] > 0 ? POS[i] : NEG[i];
        if (ta > tb) { double t = ta; ta = tb; tb = t; }
        if (ta > t0) { t0 = ta; face = f; }
        if (tb < t1) t1 = tb;
        if (t0 > t1) return 0;
    }
    if (t0 < 0 || face < 0) return 0;
    *out_t = t0;
    *out_face = face;
    return 1;
}

static int point_in_box(const double *o, const Box *bx, int cx, int cy, int cz) {
    int cell[3] = {cx, cy, cz};
    for (int i = 0; i < 3; i++)
        if (o[i] <= cell[i] + (double)bx->lo[i] || o[i] >= cell[i] + (double)bx->hi[i]) return 0;
    return 1;
}

/* Walks the grid along a ray. Mode 0 ignores fluids, mode 1 also stops at any fluid source,
   and mode 2 meets only collision boxes and reports a start inside one at distance 0. */
static Hit ray_block(const Arena *a, const double *o, const double *d, double reach, int mode) {
    Hit r = {0, 0, 0, 0, 0, 0.0};
    int x = ifloor(o[0]), y = ifloor(o[1]), z = ifloor(o[2]);
    int sx = d[0] > 0 ? 1 : -1, sy = d[1] > 0 ? 1 : -1, sz = d[2] > 0 ? 1 : -1;
    double ix = fabs(d[0]) > 1e-12 ? fabs(1 / d[0]) : 1e30, iy = fabs(d[1]) > 1e-12 ? fabs(1 / d[1]) : 1e30, iz = fabs(d[2]) > 1e-12 ? fabs(1 / d[2]) : 1e30;
    double tx = fabs(d[0]) > 1e-12 ? (d[0] > 0 ? x + 1 - o[0] : o[0] - x) * ix : 1e30;
    double ty = fabs(d[1]) > 1e-12 ? (d[1] > 0 ? y + 1 - o[1] : o[1] - y) * iy : 1e30;
    double tz = fabs(d[2]) > 1e-12 ? (d[2] > 0 ? z + 1 - o[2] : o[2] - z) * iz : 1e30;
    Box boxes[3];
    int entered = 0;
    for (int guard = 0; guard < 64; guard++) {
        if (!in_world(a->b, x, y, z)) {
            if (entered) return r;
        } else {
            entered = 1;
            uint16_t c = aget(a, x, y, z);
            if (mode == 1 && fsrc(c)) {
                Box full = mkbox(0, 0, 0, 1, 1, 1);
                double t = 0;
                int face = d[1] > 0 ? D_DOWN : D_UP;
                if (!ray_box_entry(o, d, &full, x, y, z, reach, &t, &face)) t = 0;
                r.hit = 1; r.x = x; r.y = y; r.z = z; r.face = face; r.t = t;
                return r;
            }
            int n = mode == 2 ? coll_boxes(c, boxes) : target_boxes(c, boxes);
            double best = 1e30;
            int bf = -1;
            for (int i = 0; i < n; i++) {
                double t;
                int f;
                if (mode == 2 && point_in_box(o, &boxes[i], x, y, z)) {
                    r.hit = 1; r.x = x; r.y = y; r.z = z; r.face = d[1] > 0 ? D_DOWN : D_UP; r.t = 0.0;
                    return r;
                }
                if (ray_box_entry(o, d, &boxes[i], x, y, z, reach, &t, &f) && t < best) { best = t; bf = f; }
            }
            if (bf >= 0) { r.hit = 1; r.x = x; r.y = y; r.z = z; r.face = bf; r.t = best; return r; }
        }
        double t;
        if (tx <= ty && tx <= tz) { t = tx; tx += ix; x += sx; }
        else if (tz <= ty) { t = tz; tz += iz; z += sz; }
        else { t = ty; ty += iy; y += sy; }
        if (t > reach) return r;
    }
    return r;
}

void ray_block_many(void **arenas, int n, int seats, const double *eye, const double *dir, double reach,
                    uint8_t *hit, int32_t *cell, int8_t *face, double *dist) {
    for (int i = 0; i < n; i++) for (int s = 0; s < seats; s++) {
        int k = i * seats + s;
        Hit h = ray_block(arenas[i], eye + 3 * k, dir + 3 * k, reach, 0);
        hit[k] = (uint8_t)h.hit;
        cell[3 * k] = h.x; cell[3 * k + 1] = h.y; cell[3 * k + 2] = h.z;
        face[k] = (int8_t)(h.hit ? h.face : -1);
        dist[k] = h.hit ? h.t : reach;
    }
}

void ray_collide_many(void **arenas, int n, int seats, const double *eye, const double *dir, double reach,
                      uint8_t *hit, int32_t *cell, int8_t *face, double *dist) {
    for (int i = 0; i < n; i++) for (int s = 0; s < seats; s++) {
        int k = i * seats + s;
        Hit h = ray_block(arenas[i], eye + 3 * k, dir + 3 * k, reach, 2);
        hit[k] = (uint8_t)h.hit;
        cell[3 * k] = h.x; cell[3 * k + 1] = h.y; cell[3 * k + 2] = h.z;
        face[k] = (int8_t)(h.hit ? h.face : -1);
        dist[k] = h.hit ? h.t : reach;
    }
}

/* ---------- Items and falling blocks ---------- */

static void spawn_item(Arena *a, double x, double y, double z, int item, int count, int delay,
                       double vx, double vy, double vz) {
    if (!a->items) {
        if (!mem_ok(a, MAX_ITEMS * sizeof(Item))) return;
        a->items = malloc(MAX_ITEMS * sizeof(Item));
    }
    Item *it;
    if (a->nitems < MAX_ITEMS) {
        it = &a->items[a->nitems++];
    } else {
        int old = 0;
        for (int i = 1; i < a->nitems; i++) if (a->items[i].age > a->items[old].age) old = i;
        it = &a->items[old];
    }
    it->x = x; it->y = y; it->z = z; it->vx = vx; it->vy = vy; it->vz = vz;
    it->age = 0; it->delay = delay; it->item = (uint16_t)item; it->count = (uint16_t)count; it->ground = 0;
}

static void drop_items(Arena *a, int x, int y, int z, uint16_t c) {
    int id = c & 0xFF, item = 0, count = 0;
    if (SHAPE[id] == SH_DOOR && ((c >> 12) & 1)) return;
    if (DROP_RULE[id] == DROP_LEAVES) {
        double r = rnd_unit(a);
        if (r < 0.05) { item = IT_OAK_SAPLING; count = 1; }
        else if (r < 0.07) { item = IT_STICK; count = 1 + rnd_below(a, 2); }
    } else if (DROP_RULE[id] == DROP_GRAVEL) {
        item = rnd_below(a, 10) == 0 ? IT_FLINT : B_GRAVEL;
        count = 1;
    } else if (DROP_ID[id]) {
        item = DROP_ID[id];
        count = DROP_MIN[id] + rnd_below(a, DROP_MAX[id] - DROP_MIN[id] + 1);
    }
    if (!item || count <= 0) return;
    double ox = 0.25 + rnd_unit(a) * 0.5, oy = 0.25 + rnd_unit(a) * 0.5, oz = 0.25 + rnd_unit(a) * 0.5;
    spawn_item(a, x + ox, y + oy - 0.125, z + oz, item, count, 10,
               (rnd_unit(a) - 0.5) * 0.2, 0.2, (rnd_unit(a) - 0.5) * 0.2);
}

static void pop_drop(Arena *a, int x, int y, int z, uint16_t c) { drop_items(a, x, y, z, c); }

static void step_items(Arena *a) {
    for (int i = 0; i < a->nitems; i++) {
        Item *it = &a->items[i];
        it->age++;
        if (it->delay > 0) it->delay--;
        int cx = ifloor(it->x), cy = ifloor(it->y + 0.125), cz = ifloor(it->z);
        uint16_t c = aget(a, cx, cy, cz);
        int k = (a->features & FEAT_FLUIDS) ? fkind(c) : 0;
        double top = k ? cy + fluid_height(a, cx, cy, cz, c) : 0;
        if (it->age >= 6000 || (k == B_LAVA && top > it->y)) { a->items[i--] = a->items[--a->nitems]; continue; }
        if (k == B_WATER && top - it->y > 0.1) {
            double v[3];
            flow_vector(a, cx, cy, cz, v);
            it->vx = it->vx * 0.99 + v[0] * 0.014;
            it->vz = it->vz * 0.99 + v[2] * 0.014;
            it->vy += (it->vy < 0.06 ? 5e-4 : 0.0) + v[1] * 0.014;
        } else {
            it->vy -= 0.04;
        }
        double p[3] = {it->x, it->y, it->z}, d[3] = {it->vx, it->vy, it->vz}, out[3];
        uint8_t contact, ground;
        collide_one(a, p, 0.25, 0.25, d, 0, 0.0, out, &contact, &ground);
        it->x = out[0]; it->y = out[1]; it->z = out[2];
        it->ground = ground;
        if (contact & 1) it->vx = 0;
        if (contact & 4) it->vz = 0;
        if (contact & 2) it->vy = 0;
        double fr = ground ? 0.6 * 0.98 : 0.98;
        it->vx *= fr; it->vz *= fr; it->vy *= 0.98;
    }
}

static void step_falling(Arena *a) {
    for (int i = 0; i < a->nfalling; i++) {
        Falling *f = &a->falling[i];
        f->age++;
        f->vy -= 0.04;
        AABB b = body_box((double[3]){f->x, f->y, f->z}, 0.98, 0.98);
        double m = clip_axis(a, &b, 1, f->vy);
        int landed = f->vy < 0 && m != f->vy;
        f->y += m;
        f->vy *= 0.98;
        if (!landed && f->age < 600 && f->y > Y_MIN - 8) continue;
        int cx = ifloor(f->x), cy = ifloor(f->y + 1e-6), cz = ifloor(f->z);
        uint16_t here = aget(a, cx, cy, cz), below = aget(a, cx, cy - 1, cz);
        if (landed && (FLAGS[here & 0xFF] & F_REPLACEABLE) && solid_top(below)) {
            set_cell(a, cx, cy, cz, f->cell);
        } else {
            spawn_item(a, f->x, f->y + 0.3, f->z, f->cell & 0xFF, 1, 10, 0, 0, 0);
        }
        a->falling[i--] = a->falling[--a->nfalling];
    }
}

/* ---------- Scheduled block ticks ---------- */

static int support_ok(const Arena *a, int x, int y, int z, uint16_t c) {
    int id = c & 0xFF, st = c >> 8;
    switch (SHAPE[id]) {
        case SH_TORCH: {
            int at = st & 7;
            if (at == 0) return solid_top(aget(a, x, y - 1, z));
            int side = at - 1, back = (side + 2) & 3;
            return (face_mask(aget(a, x + SX[back], y, z + SZ[back])) >> (D_NORTH + side)) & 1;
        }
        case SH_LADDER: {
            int f = st & 3, back = (f + 2) & 3;
            return (face_mask(aget(a, x + SX[back], y, z + SZ[back])) >> (D_NORTH + f)) & 1;
        }
        case SH_DOOR: {
            if ((st >> 4) & 1) {
                uint16_t lower = aget(a, x, y - 1, z);
                return (lower & 0xFF) == id && !((lower >> 12) & 1);
            }
            uint16_t upper = aget(a, x, y + 1, z);
            return solid_top(aget(a, x, y - 1, z)) && (upper & 0xFF) == id && ((upper >> 12) & 1);
        }
        default: return 1;
    }
}

static void block_tick(Arena *a, int x, int y, int z) {
    uint16_t c = aget(a, x, y, z);
    int id = c & 0xFF;
    a->block_ticks++;
    if (id == B_FIRE) { fire_tick(a, x, y, z, c); return; }
    if (FLAGS[id] & F_FALLS) {
        int bf = FLAGS[aget(a, x, y - 1, z) & 0xFF];
        if (y > Y_MIN && (bf & F_REPLACEABLE) && !(bf & F_SOLID)) {
            if (!a->falling) {
                if (!mem_ok(a, MAX_FALLING * sizeof(Falling))) return;
                a->falling = malloc(MAX_FALLING * sizeof(Falling));
            }
            if (a->nfalling >= MAX_FALLING) { schedule(a, W_BLOCK, x, y, z, 2); return; }
            Falling *f = &a->falling[a->nfalling++];
            f->x = x + 0.5; f->y = y; f->z = z + 0.5; f->vy = 0; f->age = 0; f->cell = c;
            set_cell(a, x, y, z, B_AIR);
        }
        return;
    }
    if (needs_support(c) && !support_ok(a, x, y, z, c)) {
        pop_drop(a, x, y, z, c);
        set_cell(a, x, y, z, logged(c) ? mk_fluid(B_WATER, 8, 0) : (uint16_t)B_AIR);
    }
}

static void run_wheel(Arena *a, int wheel) {
    uint32_t w = a->now & (WHEEL - 1);
    for (uint32_t i = 0; i < a->wlen[wheel][w]; i++) {
        uint32_t cell = a->wheel[wheel][w][i];
        int x, y, z;
        clear_pending(a, wheel, cell);
        cell_xyz(a->b, cell, &x, &y, &z);
        if (a->trace && a->trace_n + 3 <= a->trace_cap) {
            a->trace[a->trace_n++] = a->now;
            a->trace[a->trace_n++] = cell;
            a->trace[a->trace_n++] = (uint32_t)wheel;
        }
        if (wheel == W_BLOCK) block_tick(a, x, y, z);
        else fluid_tick(a, x, y, z);
    }
    a->wlen[wheel][w] = 0;
}

void w_tick(void *p, int n) {
    Arena *a = p;
    for (int t = 0; t < n; t++) {
        a->now++;
        for (int s = 0; s < SEATS; s++) {
            if (a->seats[s].use_cd > 0) a->seats[s].use_cd--;
        }
        run_wheel(a, W_BLOCK);
        if (a->features & FEAT_FLUIDS) run_wheel(a, W_FLUID);
        if (a->nfalling) step_falling(a);
        if (a->nitems) step_items(a);
    }
}
void w_tick_many(void **arenas, int count, int n) { for (int i = 0; i < count; i++) w_tick(arenas[i], n); }

uint16_t w_get(void *p, int x, int y, int z) { return aget(p, x, y, z); }
void w_set(void *p, int x, int y, int z, uint16_t v) { set_cell(p, x, y, z, v); }
void w_poke(void *p, int x, int y, int z, uint16_t v) { if (in_world(((Arena *)p)->b, x, y, z)) aput(p, x, y, z, v); }
void w_schedule(void *p, int wheel, int x, int y, int z, int delay) { schedule(p, wheel, x, y, z, delay); }
void w_flow(void *p, int x, int y, int z, double *out) { flow_vector(p, x, y, z, out); }
double w_fluid_height(void *p, int x, int y, int z) { return fluid_height(p, x, y, z, aget(p, x, y, z)); }

void w_trace_on(void *p, int cap) {
    Arena *a = p;
    free(a->trace);
    a->trace = malloc((size_t)cap * 4);
    a->trace_cap = cap;
    a->trace_n = 0;
}
int w_trace_read(void *p, uint32_t *out) {
    Arena *a = p;
    memcpy(out, a->trace, (size_t)a->trace_n * 4);
    return a->trace_n;
}

void w_wake_all(void *p) {
    Arena *a = p;
    const Base *b = a->b;
    if (!(a->features & FEAT_FLUIDS)) return;
    for (int sx = 0; sx < b->sx; sx++) for (int sz = 0; sz < b->sz; sz++) for (int sy = 0; sy < b->sy; sy++) {
        size_t s = ((size_t)sx * b->sz + sz) * b->sy + sy;
        uint32_t e = b->sec[s];
        int clean = !((a->dirty[s >> 6] >> (s & 63)) & 1);
        if (clean && (e & UNIFORM) && !fkind((uint16_t)e)) continue;
        for (int i = 0; i < 16; i++) for (int j = 0; j < 16; j++) for (int l = 0; l < 16; l++) {
            int x = sx * 16 + i, z = sz * 16 + j, y = sy * 16 + l + b->ylo;
            if (x >= b->nx || z >= b->nz) continue;
            int k = fkind(aget(a, x, y, z));
            if (k) schedule(a, W_FLUID, x, y, z, fdelay(k));
        }
    }
}

void w_dump(void *p, uint16_t *raw) {
    Arena *a = p;
    const Base *b = a->b;
    for (int x = 0; x < b->nx; x++) for (int z = 0; z < b->nz; z++) for (int yi = 0; yi < WORLD_H; yi++)
        raw[((size_t)x * b->nz + z) * WORLD_H + yi] = aget(a, x, yi + Y_MIN, z);
}

int w_item_count(void *p) { return ((Arena *)p)->nitems; }
void w_items(void *p, double *out) {
    Arena *a = p;
    for (int i = 0; i < a->nitems; i++) {
        const Item *it = &a->items[i];
        double row[9] = {it->x, it->y, it->z, it->item, it->count, it->delay, it->age, it->ground, it->vy};
        memcpy(out + 9 * i, row, sizeof(row));
    }
}
void w_spawn_item(void *p, double x, double y, double z, int item, int count, int delay, double vx, double vy, double vz) {
    spawn_item(p, x, y, z, item, count, delay, vx, vy, vz);
}
int w_falling_count(void *p) { return ((Arena *)p)->nfalling; }

/* Collects items whose box meets the body box grown by 1 sideways and 0.5 up and down. */
int w_pickup(void *p, const double *pos, double width, double height, int32_t *ids, int32_t *counts, int cap) {
    Arena *a = p;
    AABB b = body_box(pos, width, height);
    int got = 0;
    for (int i = 0; i < a->nitems && got < cap; i++) {
        Item *it = &a->items[i];
        if (it->delay > 0) continue;
        if (it->x + 0.125 < b.lo[0] - 1 || it->x - 0.125 > b.hi[0] + 1) continue;
        if (it->z + 0.125 < b.lo[2] - 1 || it->z - 0.125 > b.hi[2] + 1) continue;
        if (it->y + 0.25 < b.lo[1] - 0.5 || it->y > b.hi[1] + 0.5) continue;
        ids[got] = it->item;
        counts[got] = it->count;
        got++;
        a->items[i--] = a->items[--a->nitems];
    }
    return got;
}

/* ---------- Placing ---------- */

#define PLACE_OK 1
#define PLACE_COOLDOWN (-1)
#define PLACE_NO_TARGET (-2)
#define PLACE_OUT_OF_WORLD (-3)
#define PLACE_OCCUPIED (-4)
#define PLACE_BODY (-5)
#define PLACE_NO_SUPPORT (-6)
#define PLACE_DISABLED (-7)
#define USE_COOLDOWN 4
#define REACH 4.5

static inline int yaw_side(double yaw) {
    int q = ifloor((yaw + 45.0) / 90.0) & 3;
    return (q + 2) & 3;
}
static inline int replaceable(uint16_t c) { return (FLAGS[c & 0xFF] & F_REPLACEABLE) != 0; }
static inline int can_log(uint16_t c) {
    if (!(FLAGS[c & 0xFF] & F_WATERLOG) || (c & LOGGED)) return 0;
    return !(SHAPE[c & 0xFF] == SH_SLAB && ((c >> 8) & 3) == 2);
}

static int shape_hits_bodies(uint16_t c, int x, int y, int z, const double *bodies, int nb) {
    Box bx[3];
    int n = coll_boxes(c, bx);
    double cell[3] = {x, y, z};
    for (int b = 0; b < nb; b++) {
        const double *lo = bodies + 6 * b, *hi = lo + 3;
        for (int i = 0; i < n; i++) {
            int hit = 1;
            for (int k = 0; k < 3; k++)
                if (hi[k] <= cell[k] + bx[i].lo[k] + EPS || lo[k] >= cell[k] + bx[i].hi[k] - EPS) { hit = 0; break; }
            if (hit) return 1;
        }
    }
    return 0;
}

int w_place(void *p, int seat, int block, const double *eye, const double *look, double yaw,
            const double *bodies, int nb, int32_t *out) {
    Arena *a = p;
    Seat *s = &a->seats[seat];
    if (s->use_cd > 0) return PLACE_COOLDOWN;
    Hit h = ray_block(a, eye, look, REACH, 0);
    if (!h.hit) return PLACE_NO_TARGET;
    double hx = eye[0] + look[0] * h.t, hy = eye[1] + look[1] * h.t, hz = eye[2] + look[2] * h.t;
    double fy = hy - h.y;
    int shape = SHAPE[block], merge = 0, is_side = h.face >= D_NORTH;
    int up = h.face == D_DOWN || (is_side && fy > 0.5);
    uint16_t hc = aget(a, h.x, h.y, h.z);
    int tx = h.x, ty = h.y, tz = h.z;
    if (shape == SH_SLAB && (hc & 0xFF) == block) {
        int t = (hc >> 8) & 3;
        if ((t == 0 && (h.face == D_UP || (is_side && fy > 0.5))) || (t == 1 && (h.face == D_DOWN || (is_side && fy <= 0.5))))
            merge = 1;
    }
    if (!merge && !replaceable(hc)) { tx += DX6[h.face]; ty += DY6[h.face]; tz += DZ6[h.face]; }
    if (!in_world(a->b, tx, ty, tz)) return PLACE_OUT_OF_WORLD;
    uint16_t cur = aget(a, tx, ty, tz);
    if (!merge && shape == SH_SLAB && (cur & 0xFF) == block && ((cur >> 8) & 3) != 2 && ((cur >> 8) & 3) != up) merge = 1;
    if (!merge && !replaceable(cur)) return PLACE_OCCUPIED;
    uint16_t nw = (uint16_t)block, upper = 0;
    int side = yaw_side(yaw);
    switch (shape) {
        case SH_SLAB:
            nw |= (uint16_t)((merge ? 2 : up) << 8);
            break;
        case SH_STAIRS:
            nw |= (uint16_t)((side | (up << 2)) << 8);
            break;
        case SH_LADDER: {
            if (!is_side) return PLACE_NO_SUPPORT;
            int f = h.face - D_NORTH, back = (f + 2) & 3;
            if (!((face_mask(aget(a, tx + SX[back], ty, tz + SZ[back])) >> (D_NORTH + f)) & 1)) return PLACE_NO_SUPPORT;
            nw |= (uint16_t)(f << 8);
            break;
        }
        case SH_TORCH: {
            if (h.face == D_DOWN) return PLACE_NO_SUPPORT;
            if (h.face == D_UP) {
                if (!solid_top(aget(a, tx, ty - 1, tz))) return PLACE_NO_SUPPORT;
            } else {
                int f = h.face - D_NORTH, back = (f + 2) & 3;
                if (!((face_mask(aget(a, tx + SX[back], ty, tz + SZ[back])) >> (D_NORTH + f)) & 1)) return PLACE_NO_SUPPORT;
                nw |= (uint16_t)((f + 1) << 8);
            }
            break;
        }
        case SH_DOOR: {
            if (!in_world(a->b, tx, ty + 1, tz) || !replaceable(aget(a, tx, ty + 1, tz))) return PLACE_OCCUPIED;
            if (!solid_top(aget(a, tx, ty - 1, tz))) return PLACE_NO_SUPPORT;
            int r = (side + 1) & 3;
            double along = SX[r] * (hx - tx - 0.5) + SZ[r] * (hz - tz - 0.5);
            nw |= (uint16_t)((side | ((along > 0) << 3)) << 8);
            upper = (uint16_t)(nw | (1 << 12));
            break;
        }
        default:
            if (block == B_OAK_LOG) nw |= (uint16_t)((h.face <= D_UP ? 1 : (h.face == D_EAST || h.face == D_WEST) ? 0 : 2) << 8);
            else if (block == B_OAK_LEAVES) nw |= (uint16_t)((7 | (1 << 3)) << 8);
            break;
    }
    if ((FLAGS[block] & F_WATERLOG) && !merge && (cur & 0xFF) == B_WATER && fsrc(cur)) nw |= LOGGED;
    if (shape == SH_STAIRS) nw = with_stair_shape(nw, stair_shape(a, tx, ty, tz, nw));
    if (shape_hits_bodies(nw, tx, ty, tz, bodies, nb)) return PLACE_BODY;
    if (upper && shape_hits_bodies(upper, tx, ty + 1, tz, bodies, nb)) return PLACE_BODY;
    set_cell(a, tx, ty, tz, nw);
    if (upper) set_cell(a, tx, ty + 1, tz, upper);
    s->use_cd = USE_COOLDOWN;
    if (out) { out[0] = tx; out[1] = ty; out[2] = tz; }
    return PLACE_OK;
}

void place_many(void **arenas, int n, int seats, const int32_t *blocks, const uint8_t *act, const double *eye,
                const double *look, const double *yaw, const double *bodies, int32_t *codes) {
    for (int i = 0; i < n; i++) for (int s = 0; s < seats; s++) {
        int k = i * seats + s;
        codes[k] = act[k] ? w_place(arenas[i], s, blocks[k], eye + 3 * k, look + 3 * k, yaw[k], bodies + 6 * i * seats, seats, NULL) : 0;
    }
}

/* ---------- Breaking ---------- */

#define DIG_DELAY 5

void w_dig_stop(void *p, int seat) {
    Seat *s = &((Arena *)p)->seats[seat];
    s->digging = 0;
    s->progress = 0.0;
}

/* Returns 1 on a break, 0 on progress and a negative code when nothing is dug.
   Out holds x, y, z, block, harvest flag and durability cost. */
int w_dig(void *p, int seat, int tool, int tier, int efficiency, int haste, int fatigue, int aqua, int unbreaking,
          int on_ground, const double *eye, const double *look, int32_t *out) {
    static const double FATIGUE[4] = {0.3, 0.09, 0.0027, 0.00081};
    Arena *a = p;
    Seat *s = &a->seats[seat];
    Hit h = ray_block(a, eye, look, REACH, 0);
    if (!h.hit) { w_dig_stop(p, seat); return -2; }
    uint16_t c = aget(a, h.x, h.y, h.z);
    int id = c & 0xFF;
    double hard = HARDNESS[id];
    if (hard < 0) { w_dig_stop(p, seat); return -3; }
    int fresh = !s->digging || s->dx != h.x || s->dy != h.y || s->dz != h.z;
    if (fresh) {
        s->digging = 1; s->dx = h.x; s->dy = h.y; s->dz = h.z; s->progress = 0.0;
    }
    int match = tool > 0 && ((TOOLS[id] >> tool) & 1);
    double speed = 1.0;
    if (tool == TOOL_SWORD) speed = id == B_COBWEB ? 15.0 : id == B_OAK_LEAVES ? 1.5 : 1.0;
    else if (tool == TOOL_SHEARS) speed = (id == B_COBWEB || id == B_OAK_LEAVES) ? 15.0 : 1.0;
    else if (match) speed = TIER_SPEED[tier];
    if (match && efficiency > 0) speed += efficiency * efficiency + 1;
    if (haste > 0) speed *= 1.0 + 0.2 * haste;
    if (fatigue > 0) speed *= FATIGUE[(fatigue > 4 ? 4 : fatigue) - 1];
    int ex = ifloor(eye[0]), ey = ifloor(eye[1]), ez = ifloor(eye[2]);
    uint16_t ec = aget(a, ex, ey, ez);
    if (fkind(ec) == B_WATER && eye[1] < ey + fluid_height(a, ex, ey, ez, ec) && !aqua) speed *= 0.2;
    if (!on_ground) speed /= 5.0;
    int harvest = !(FLAGS[id] & F_NEEDS_TOOL) || (match && TIER_RANK[tier] >= MIN_RANK[id]);
    double step = hard == 0.0 ? 1.0 : speed / hard / (harvest ? 30.0 : 100.0);
    /* The delay after a break runs down only on ticks spent digging at a block.
       A block that breaks on its first tick ignores it. */
    if (s->dig_delay > 0 && !(fresh && step >= 1.0 - 1e-9)) { s->dig_delay--; return -1; }
    int first = s->progress == 0.0;
    s->progress = hard == 0.0 ? 1.0 : s->progress + step;
    if (s->progress < 1.0 - 1e-6) return 0;
    s->digging = 0;
    s->progress = 0.0;
    if (!first) s->dig_delay = DIG_DELAY;
    uint16_t drop_cell = c;
    if (SHAPE[id] == SH_DOOR) {
        int oy = ((c >> 12) & 1) ? h.y - 1 : h.y + 1;
        if ((aget(a, h.x, oy, h.z) & 0xFF) == id) set_cell(a, h.x, oy, h.z, B_AIR);
        drop_cell = (uint16_t)(c & ~(1 << 12));
    }
    set_cell(a, h.x, h.y, h.z, logged(c) ? mk_fluid(B_WATER, 8, 0) : (uint16_t)B_AIR);
    if (harvest) drop_items(a, h.x, h.y, h.z, drop_cell);
    int units = (hard > 0 && tool > 0) ? (tool == TOOL_SWORD ? 2 : 1) : 0, cost = 0;
    for (int u = 0; u < units; u++) if (unbreaking <= 0 || rnd_below(a, 1 + unbreaking) == 0) cost++;
    if (out) { out[0] = h.x; out[1] = h.y; out[2] = h.z; out[3] = id; out[4] = harvest; out[5] = cost; }
    return 1;
}

void dig_many(void **arenas, int n, int seats, const uint8_t *act, const int32_t *tool, const int32_t *tier,
              const uint8_t *on_ground, const double *eye, const double *look, int32_t *codes, int32_t *out) {
    for (int i = 0; i < n; i++) for (int s = 0; s < seats; s++) {
        int k = i * seats + s;
        if (!act[k]) { w_dig_stop(arenas[i], s); codes[k] = 0; continue; }
        codes[k] = w_dig(arenas[i], s, tool[k], tier[k], 0, 0, 0, 0, 0, on_ground[k], eye + 3 * k, look + 3 * k, out + 6 * k);
    }
}

/* ---------- Buckets ---------- */

int w_bucket_fill(void *p, int seat, const double *eye, const double *look, int32_t *out) {
    Arena *a = p;
    Seat *s = &a->seats[seat];
    if (!(a->features & FEAT_FLUIDS)) return PLACE_DISABLED;
    if (s->use_cd > 0) return PLACE_COOLDOWN;
    Hit h = ray_block(a, eye, look, REACH, 1);
    if (!h.hit) return 0;
    uint16_t c = aget(a, h.x, h.y, h.z);
    if (!fsrc(c)) return 0;
    int k = fkind(c);
    set_cell(a, h.x, h.y, h.z, logged(c) ? (uint16_t)(c & ~LOGGED) : (uint16_t)B_AIR);
    s->use_cd = USE_COOLDOWN;
    if (out) { out[0] = h.x; out[1] = h.y; out[2] = h.z; }
    return k;
}

int w_bucket_empty(void *p, int seat, int kind, const double *eye, const double *look, int32_t *out) {
    Arena *a = p;
    Seat *s = &a->seats[seat];
    if (!(a->features & FEAT_FLUIDS)) return PLACE_DISABLED;
    if (s->use_cd > 0) return PLACE_COOLDOWN;
    Hit h = ray_block(a, eye, look, REACH, 0);
    if (!h.hit) return PLACE_NO_TARGET;
    uint16_t hc = aget(a, h.x, h.y, h.z);
    int tx = h.x, ty = h.y, tz = h.z;
    uint16_t cur = hc;
    if (!(kind == B_WATER && can_log(hc)) && !replaceable(hc)) {
        tx += DX6[h.face]; ty += DY6[h.face]; tz += DZ6[h.face];
        if (!in_world(a->b, tx, ty, tz)) return PLACE_OUT_OF_WORLD;
        cur = aget(a, tx, ty, tz);
    }
    if (kind == B_WATER && can_log(cur)) {
        set_cell(a, tx, ty, tz, (uint16_t)(cur | LOGGED));
    } else {
        if (!replaceable(cur) || (fsrc(cur) && fkind(cur) == kind)) return PLACE_OCCUPIED;
        set_cell(a, tx, ty, tz, mk_fluid(kind, 8, 0));
    }
    s->use_cd = USE_COOLDOWN;
    if (out) { out[0] = tx; out[1] = ty; out[2] = tz; }
    return PLACE_OK;
}

/* ---------- Sight ---------- */

#define SIGHT_MAX 15
#define RING 32
#define RING_BYTES (RING * RING * RING)

typedef struct { int n; int32_t *pred[32]; int8_t *ox, *oy, *oz; } SightTable;
static SightTable TABLES[SIGHT_MAX + 1];

/* One of four points inside a cell, chosen on the sides that face the eye:
   the near corner, the near vertical face, the near horizontal face and the near vertical edge. */
static inline void target_point(int ox, int oy, int oz, int phase, double *q) {
    double nx = ox > 0 ? .06 : ox < 0 ? .94 : .5, ny = oy > 0 ? .06 : oy < 0 ? .94 : .5, nz = oz > 0 ? .06 : oz < 0 ? .94 : .5;
    int wide = abs(ox) >= abs(oz);
    switch (phase) {
        case 0: q[0] = nx; q[1] = ny; q[2] = nz; break;
        case 1: q[0] = .5; q[1] = ny; q[2] = .5; break;
        case 2: q[0] = wide ? nx : .5; q[1] = .5; q[2] = wide ? .5 : nz; break;
        default: q[0] = nx; q[1] = .5; q[2] = nz; break;
    }
}

/* Lists cells nearest first. For each eye octant and target point, stores the face neighbour
   just before each cell on the straight line from the eye. */
static void sight_build(int r) {
    SightTable *v = &TABLES[r];
    if (v->n) return;
    int w = 2 * r + 1, total = w * w * w, maxm = 3 * r, count = 0;
    int32_t *of = malloc((size_t)total * 4);
    int *bucket = calloc((size_t)maxm + 2, sizeof(int));
    double lim = (r + 0.5) * (r + 0.5);
    for (int x = -r; x <= r; x++) for (int y = -r; y <= r; y++) for (int z = -r; z <= r; z++)
        if (x * x + y * y + z * z <= lim) { bucket[abs(x) + abs(y) + abs(z) + 1]++; count++; }
    for (int m = 1; m <= maxm + 1; m++) bucket[m] += bucket[m - 1];
    v->ox = malloc((size_t)count); v->oy = malloc((size_t)count); v->oz = malloc((size_t)count);
    for (int i = 0; i < total; i++) of[i] = -1;
    for (int x = -r; x <= r; x++) for (int y = -r; y <= r; y++) for (int z = -r; z <= r; z++)
        if (x * x + y * y + z * z <= lim) {
            int k = bucket[abs(x) + abs(y) + abs(z)]++;
            v->ox[k] = (int8_t)x; v->oy[k] = (int8_t)y; v->oz[k] = (int8_t)z;
            of[((x + r) * w + (z + r)) * w + (y + r)] = k;
        }
    for (int o = 0; o < 32; o++) {
        v->pred[o] = malloc((size_t)count * 4);
        double fx = (o & 1) ? .75 : .25, fy = (o & 2) ? .75 : .25, fz = (o & 4) ? .75 : .25;
        for (int k = 0; k < count; k++) {
            int tx = v->ox[k], ty = v->oy[k], tz = v->oz[k], cx = 0, cy = 0, cz = 0, px = 0, py = 0, pz = 0;
            double tp[3];
            target_point(tx, ty, tz, o >> 3, tp);
            double dx = tx + tp[0] - fx, dy = ty + tp[1] - fy, dz = tz + tp[2] - fz;
            int sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
            double ix = fabs(dx) > 1e-12 ? 1 / fabs(dx) : 1e30, iy = fabs(dy) > 1e-12 ? 1 / fabs(dy) : 1e30, iz = fabs(dz) > 1e-12 ? 1 / fabs(dz) : 1e30;
            double ax = (dx > 0 ? 1 - fx : fx) * ix, ay = (dy > 0 ? 1 - fy : fy) * iy, az = (dz > 0 ? 1 - fz : fz) * iz;
            while (cx != tx || cy != ty || cz != tz) {
                px = cx; py = cy; pz = cz;
                int bx = cx != tx, by = cy != ty, bz = cz != tz;
                if (bx && (!by || ax <= ay) && (!bz || ax <= az)) { cx += sx; ax += ix; }
                else if (bz && (!by || az <= ay)) { cz += sz; az += iz; }
                else { cy += sy; ay += iy; }
            }
            v->pred[o][k] = k ? of[((px + r) * w + (pz + r)) * w + (py + r)] : -1;
        }
    }
    v->n = count;
    free(of);
    free(bucket);
}

int sight_table_cells(int r) { sight_build(r); return TABLES[r].n; }

static inline int sight_opaque(uint16_t c) {
    int id = c & 0xFF;
    if (FLAGS[id] & F_OPAQUE) return 1;
    return SHAPE[id] == SH_SLAB && ((c >> 8) & 3) == 2;
}
static inline uint32_t ring_addr(int x, int y, int z) {
    return ((uint32_t)(x & 31) << 10) | ((uint32_t)(z & 31) << 5) | (uint32_t)(y & 31);
}
static inline int ring_has(const Mem *m, int x, int y, int z) {
    return m->init && x >= m->cx - 16 && x < m->cx + 16 && y >= m->cy - 16 && y < m->cy + 16 && z >= m->cz - 16 && z < m->cz + 16;
}
static void ring_clear_x(Mem *m, int x) { memset(m->m + ((x & 31) << 10), 0, 1024); }
static void ring_clear_z(Mem *m, int z) { for (int x = 0; x < RING; x++) memset(m->m + (x << 10) + ((z & 31) << 5), 0, RING); }
static void ring_clear_y(Mem *m, int y) { for (int i = 0; i < 1024; i++) m->m[(i << 5) | (y & 31)] = 0; }

static void ring_center(Mem *m, int x, int y, int z) {
    if (!m->init || abs(x - m->cx) >= RING || abs(y - m->cy) >= RING || abs(z - m->cz) >= RING) {
        memset(m->m, 0, RING_BYTES);
        m->cx = x; m->cy = y; m->cz = z; m->init = 1;
        return;
    }
    while (m->cx < x) { m->cx++; ring_clear_x(m, m->cx + 15); }
    while (m->cx > x) { m->cx--; ring_clear_x(m, m->cx - 16); }
    while (m->cz < z) { m->cz++; ring_clear_z(m, m->cz + 15); }
    while (m->cz > z) { m->cz--; ring_clear_z(m, m->cz - 16); }
    while (m->cy < y) { m->cy++; ring_clear_y(m, m->cy + 15); }
    while (m->cy > y) { m->cy--; ring_clear_y(m, m->cy - 16); }
}

static Mem *seat_mem(Arena *a, int seat) {
    Seat *s = &a->seats[seat];
    if (!s->mem) {
        s->mem = calloc(1, sizeof(Mem));
        a->mem += sizeof(Mem);
    }
    return s->mem;
}

static inline int class_notable(int v) { return v > 1 && (FLAGS[v - 1] & F_NOTABLE); }

static void note_cell(Mem *m, int x, int y, int z, int old, int val, uint32_t tick) {
    if (!class_notable(old) && !class_notable(val)) return;
    int at = -1;
    for (int i = 0; i < m->nnotable; i++)
        if (m->notable[i].x == x && m->notable[i].y == y && m->notable[i].z == z) { at = i; break; }
    if (!class_notable(val)) {
        if (at >= 0) m->notable[at] = m->notable[--m->nnotable];
        return;
    }
    if (at < 0) {
        if (m->nnotable < NOTABLE_MAX) {
            at = m->nnotable++;
        } else {
            int64_t far = -1;
            for (int i = 0; i < m->nnotable; i++) {
                int64_t dx = m->notable[i].x - m->cx, dy = m->notable[i].y - m->cy, dz = m->notable[i].z - m->cz;
                int64_t d = dx * dx + dy * dy + dz * dz;
                if (d > far) { far = d; at = i; }
            }
        }
    }
    m->notable[at].x = x; m->notable[at].y = y; m->notable[at].z = z;
    m->notable[at].tick = tick; m->notable[at].kind = (uint8_t)val;
}

/* Exact walk from the true eye to one point in the target cell. Every cell between must be see through. */
static int clear_line(const Arena *a, double ex, double ey, double ez, double qx, double qy, double qz, int tx, int ty, int tz) {
    int x = ifloor(ex), y = ifloor(ey), z = ifloor(ez);
    if (x == tx && y == ty && z == tz) return 1;
    double dx = qx - ex, dy = qy - ey, dz = qz - ez;
    int sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    double ix = fabs(dx) > 1e-12 ? 1 / fabs(dx) : 1e30, iy = fabs(dy) > 1e-12 ? 1 / fabs(dy) : 1e30, iz = fabs(dz) > 1e-12 ? 1 / fabs(dz) : 1e30;
    double ax = fabs(dx) > 1e-12 ? (dx > 0 ? x + 1 - ex : ex - x) * ix : 1e30;
    double ay = fabs(dy) > 1e-12 ? (dy > 0 ? y + 1 - ey : ey - y) * iy : 1e30;
    double az = fabs(dz) > 1e-12 ? (dz > 0 ? z + 1 - ez : ez - z) * iz : 1e30;
    for (int guard = 0; guard < 96; guard++) {
        if (ax <= ay && ax <= az) { x += sx; ax += ix; }
        else if (az <= ay) { z += sz; az += iz; }
        else { y += sy; ay += iy; }
        if (x == tx && y == ty && z == tz) return 1;
        if (sight_opaque(aget(a, x, y, z))) return 0;
    }
    return 0;
}

/* Updates one body's memory from its eye. A cell is read only through a see through neighbour
   already reached, so a block covered on all six faces is never read. */
uint64_t w_see(void *ap, int seat, double ex, double ey, double ez, double yaw, double pitch, int r) {
    static const double TH = 1.4281480067421146, TV = 0.7002075382097097;
    Arena *a = ap;
    Mem *t = seat_mem(a, seat);
    if (r > SIGHT_MAX) r = SIGHT_MAX;
    sight_build(r);
    const SightTable *v = &TABLES[r];
    int ix = ifloor(ex), iy = ifloor(ey), iz = ifloor(ez);
    double fx = ex - ix, fy = ey - iy, fz = ez - iz;
    int o = (fx >= .5) | ((fy >= .5) << 1) | ((fz >= .5) << 2), jit = t->phase & 3;
    const int32_t *pred = v->pred[o | (jit << 3)];
    t->phase = (t->phase + 1) & 3;
    ring_center(t, ix, iy, iz);
    double yr = yaw * PI / 180, pr = pitch * PI / 180, sy = sin(yr), cy = cos(yr), sp = sin(pr), cp = cos(pr);
    double Fx = -sy * cp, Fy = -sp, Fz = cy * cp, Rx = cy, Rz = sy, Ux = -sy * sp, Uy = cp, Uz = cy * sp;
    double pl[5][3] = {{Rx - TH * Fx, -TH * Fy, Rz - TH * Fz}, {-Rx - TH * Fx, -TH * Fy, -Rz - TH * Fz},
                       {Ux - TV * Fx, Uy - TV * Fy, Uz - TV * Fz}, {-Ux - TV * Fx, -Uy - TV * Fy, -Uz - TV * Fz},
                       {-Fx, -Fy, -Fz}};
    double rad[5];
    for (int q = 0; q < 5; q++) rad[q] = .5 * (fabs(pl[q][0]) + fabs(pl[q][1]) + fabs(pl[q][2]));
    uint8_t open[v->n];
    memset(open, 0, (size_t)v->n);
    uint64_t reads = 1;
    uint16_t here = aget(a, ix, iy, iz);
    open[0] = !sight_opaque(here);
    if (in_world(a->b, ix, iy, iz)) {
        uint32_t ad = ring_addr(ix, iy, iz);
        int val = (here & 0xFF) + 1;
        if (t->m[ad] != val) { note_cell(t, ix, iy, iz, t->m[ad], val, a->now); t->m[ad] = (uint8_t)val; }
    }
    for (int k = 1; k < v->n; k++) {
        if (!open[pred[k]]) continue;
        double dx = v->ox[k] + .5 - fx, dy = v->oy[k] + .5 - fy, dz = v->oz[k] + .5 - fz;
        int in = 1;
        for (int q = 0; q < 5; q++)
            if (pl[q][0] * dx + pl[q][1] * dy + pl[q][2] * dz - rad[q] > 0) { in = 0; break; }
        if (!in) continue;
        int x = ix + v->ox[k], y = iy + v->oy[k], z = iz + v->oz[k];
        if (!in_world(a->b, x, y, z)) continue;
        uint16_t st = aget(a, x, y, z);
        reads++;
        uint32_t ad = ring_addr(x, y, z);
        int val = (st & 0xFF) + 1;
        if (t->m[ad] != val) {
            double tp[3];
            target_point(v->ox[k], v->oy[k], v->oz[k], jit, tp);
            if (clear_line(a, ex, ey, ez, x + tp[0], y + tp[1], z + tp[2], x, y, z)) {
                note_cell(t, x, y, z, t->m[ad], val, a->now);
                t->m[ad] = (uint8_t)val;
            }
        }
        open[k] = !sight_opaque(st);
    }
    return reads;
}

/* ---------- View of a body's memory ---------- */

void view_crop(void *ap, int seat, uint8_t *out, int rx, int ry, int rz) {
    Mem *t = seat_mem(ap, seat);
    int c = 0;
    for (int x = -rx; x <= rx; x++) for (int z = -rz; z <= rz; z++) for (int y = -ry; y <= ry; y++) {
        int wx = t->cx + x, wy = t->cy + y, wz = t->cz + z;
        out[c++] = ring_has(t, wx, wy, wz) ? t->m[ring_addr(wx, wy, wz)] : 0;
    }
}

/* Walks remembered cells. Returns 0 at the range limit, 1 at a remembered blocker, 2 at unknown. */
int view_ray(void *ap, int seat, const double *o, const double *d, double max_t, double *dist) {
    Mem *t = seat_mem(ap, seat);
    int x = ifloor(o[0]), y = ifloor(o[1]), z = ifloor(o[2]);
    int sx = d[0] > 0 ? 1 : -1, sy = d[1] > 0 ? 1 : -1, sz = d[2] > 0 ? 1 : -1;
    double ix = fabs(d[0]) > 1e-12 ? fabs(1 / d[0]) : 1e30, iy = fabs(d[1]) > 1e-12 ? fabs(1 / d[1]) : 1e30, iz = fabs(d[2]) > 1e-12 ? fabs(1 / d[2]) : 1e30;
    double tx = fabs(d[0]) > 1e-12 ? (d[0] > 0 ? x + 1 - o[0] : o[0] - x) * ix : 1e30;
    double ty = fabs(d[1]) > 1e-12 ? (d[1] > 0 ? y + 1 - o[1] : o[1] - y) * iy : 1e30;
    double tz = fabs(d[2]) > 1e-12 ? (d[2] > 0 ? z + 1 - o[2] : o[2] - z) * iz : 1e30;
    double now = 0;
    for (int guard = 0; guard < 128; guard++) {
        if (tx <= ty && tx <= tz) { now = tx; tx += ix; x += sx; }
        else if (tz <= ty) { now = tz; tz += iz; z += sz; }
        else { now = ty; ty += iy; y += sy; }
        if (now > max_t) break;
        int v = ring_has(t, x, y, z) ? t->m[ring_addr(x, y, z)] : 0;
        if (!v) { *dist = now; return 2; }
        if (FLAGS[v - 1] & F_SOLID) { *dist = now; return 1; }
    }
    *dist = max_t;
    return 0;
}

/* Answers a fan of rays per body from its memory. A ray stops at a remembered solid block, lava,
   fire or an unknown cell. The class is 0 at unknown and air at the range limit. Water is reported
   at its surface and does not stop the ray, with -1 when the ray met none. */
void view_rays_many(void **arenas, const int32_t *rows, int n, int seat, const double *eye, const double *dirs,
                    int rays, double max_t, double *dist, uint8_t *cls, double *water) {
    for (int b = 0; b < n; b++) {
        Mem *t = seat_mem(arenas[rows[b]], seat);
        const double *o = eye + 3 * b;
        int x0 = ifloor(o[0]), y0 = ifloor(o[1]), z0 = ifloor(o[2]);
        int start = ring_has(t, x0, y0, z0) ? t->m[ring_addr(x0, y0, z0)] : 0;
        for (int r = 0; r < rays; r++) {
            const double *d = dirs + 3 * (b * rays + r);
            int k = b * rays + r, x = x0, y = y0, z = z0;
            int sx = d[0] > 0 ? 1 : -1, sy = d[1] > 0 ? 1 : -1, sz = d[2] > 0 ? 1 : -1;
            double ix = fabs(d[0]) > 1e-12 ? fabs(1 / d[0]) : 1e30, iy = fabs(d[1]) > 1e-12 ? fabs(1 / d[1]) : 1e30, iz = fabs(d[2]) > 1e-12 ? fabs(1 / d[2]) : 1e30;
            double tx = fabs(d[0]) > 1e-12 ? (d[0] > 0 ? x + 1 - o[0] : o[0] - x) * ix : 1e30;
            double ty = fabs(d[1]) > 1e-12 ? (d[1] > 0 ? y + 1 - o[1] : o[1] - y) * iy : 1e30;
            double tz = fabs(d[2]) > 1e-12 ? (d[2] > 0 ? z + 1 - o[2] : o[2] - z) * iz : 1e30;
            double now = 0;
            dist[k] = max_t;
            cls[k] = B_AIR + 1;
            water[k] = start == B_WATER + 1 ? 0 : -1;
            for (int guard = 0; guard < 128; guard++) {
                if (tx <= ty && tx <= tz) { now = tx; tx += ix; x += sx; }
                else if (tz <= ty) { now = tz; tz += iz; z += sz; }
                else { now = ty; ty += iy; y += sy; }
                if (now > max_t) break;
                int v = ring_has(t, x, y, z) ? t->m[ring_addr(x, y, z)] : 0;
                if (!v) { dist[k] = now; cls[k] = 0; break; }
                if ((FLAGS[v - 1] & F_SOLID) || v == B_LAVA + 1 || v == B_FIRE + 1) { dist[k] = now; cls[k] = (uint8_t)v; break; }
                if (v == B_WATER + 1 && water[k] < 0) water[k] = now;
            }
        }
    }
}

/* Part of each body's sight update. Records which straight lines from the eye to given points are
   open. Inside the field of view a line stops at the first opaque block the eye meets. Outside it
   only remembered opaque blocks stop the line. Neither case reads past the first opaque cell. */
void see_lines_many(void **arenas, const int32_t *rows, int n, int seats, const double *eye, const double *yaw,
                    const double *pitch, const double *targets, int lines) {
    static const double TH = 1.4281480067421146, TV = 0.7002075382097097;
    for (int b = 0; b < n; b++) for (int s = 0; s < seats; s++) {
        Arena *a = arenas[rows[b]];
        Mem *t = seat_mem(a, s);
        int body = b * seats + s;
        const double *e = eye + 3 * body;
        double yr = yaw[body] * PI / 180, pr = pitch[body] * PI / 180, sy = sin(yr), cy = cos(yr), sp = sin(pr), cp = cos(pr);
        double Fx = -sy * cp, Fy = -sp, Fz = cy * cp, Rx = cy, Rz = sy, Ux = -sy * sp, Uy = cp, Uz = cy * sp;
        double pl[5][3] = {{Rx - TH * Fx, -TH * Fy, Rz - TH * Fz}, {-Rx - TH * Fx, -TH * Fy, -Rz - TH * Fz},
                           {Ux - TV * Fx, Uy - TV * Fy, Uz - TV * Fz}, {-Ux - TV * Fx, -Uy - TV * Fy, -Uz - TV * Fz},
                           {-Fx, -Fy, -Fz}};
        uint8_t bits = 0;
        for (int l = 0; l < lines; l++) {
            const double *q = targets + 3 * (body * lines + l);
            double dx = q[0] - e[0], dy = q[1] - e[1], dz = q[2] - e[2];
            int in_view = 1;
            for (int p = 0; p < 5; p++)
                if (pl[p][0] * dx + pl[p][1] * dy + pl[p][2] * dz > 0) { in_view = 0; break; }
            int x = ifloor(e[0]), y = ifloor(e[1]), z = ifloor(e[2]), qx = ifloor(q[0]), qy = ifloor(q[1]), qz = ifloor(q[2]);
            int sx = dx > 0 ? 1 : -1, step_y = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1, open = 1;
            double ix = fabs(dx) > 1e-12 ? 1 / fabs(dx) : 1e30, iy = fabs(dy) > 1e-12 ? 1 / fabs(dy) : 1e30, iz = fabs(dz) > 1e-12 ? 1 / fabs(dz) : 1e30;
            double ax = fabs(dx) > 1e-12 ? (dx > 0 ? x + 1 - e[0] : e[0] - x) * ix : 1e30;
            double ay = fabs(dy) > 1e-12 ? (dy > 0 ? y + 1 - e[1] : e[1] - y) * iy : 1e30;
            double az = fabs(dz) > 1e-12 ? (dz > 0 ? z + 1 - e[2] : e[2] - z) * iz : 1e30;
            for (int guard = 0; guard < 1024 && (x != qx || y != qy || z != qz); guard++) {
                double next = ax < ay ? (ax < az ? ax : az) : (ay < az ? ay : az);
                if (next >= 1) break;
                if (ax <= ay && ax <= az) { x += sx; ax += ix; }
                else if (az <= ay) { z += sz; az += iz; }
                else { y += step_y; ay += iy; }
                if (x == qx && y == qy && z == qz) break;
                if (in_view) {
                    if (sight_opaque(aget(a, x, y, z))) { open = 0; break; }
                } else {
                    int v = ring_has(t, x, y, z) ? t->m[ring_addr(x, y, z)] : 0;
                    if (v && (FLAGS[v - 1] & F_OPAQUE)) { open = 0; break; }
                }
            }
            if (open) bits |= (uint8_t)(1 << l);
        }
        t->line_bits = bits;
    }
}

/* Reads the lines each body found open at its last sight update. */
void view_lines_many(void **arenas, const int32_t *rows, int n, int seat, int lines, uint8_t *out) {
    for (int b = 0; b < n; b++) {
        const Mem *t = seat_mem(arenas[rows[b]], seat);
        for (int l = 0; l < lines; l++) out[b * lines + l] = (t->line_bits >> l) & 1;
    }
}

/* Class of the first remembered block on the look ray within reach, skipping air and fluids.
   Returns 0 when the ray meets an unknown cell first and 1 when nothing is in reach. */
int view_target(void *ap, int seat, const double *o, const double *d) {
    Mem *t = seat_mem(ap, seat);
    int x = ifloor(o[0]), y = ifloor(o[1]), z = ifloor(o[2]);
    int sx = d[0] > 0 ? 1 : -1, sy = d[1] > 0 ? 1 : -1, sz = d[2] > 0 ? 1 : -1;
    double ix = fabs(d[0]) > 1e-12 ? fabs(1 / d[0]) : 1e30, iy = fabs(d[1]) > 1e-12 ? fabs(1 / d[1]) : 1e30, iz = fabs(d[2]) > 1e-12 ? fabs(1 / d[2]) : 1e30;
    double tx = fabs(d[0]) > 1e-12 ? (d[0] > 0 ? x + 1 - o[0] : o[0] - x) * ix : 1e30;
    double ty = fabs(d[1]) > 1e-12 ? (d[1] > 0 ? y + 1 - o[1] : o[1] - y) * iy : 1e30;
    double tz = fabs(d[2]) > 1e-12 ? (d[2] > 0 ? z + 1 - o[2] : o[2] - z) * iz : 1e30;
    for (int guard = 0; guard < 16; guard++) {
        double now;
        if (tx <= ty && tx <= tz) { now = tx; tx += ix; x += sx; }
        else if (tz <= ty) { now = tz; tz += iz; z += sz; }
        else { now = ty; ty += iy; y += sy; }
        if (now > REACH) break;
        int v = ring_has(t, x, y, z) ? t->m[ring_addr(x, y, z)] : 0;
        if (!v) return 0;
        if (v != B_AIR + 1 && v != B_WATER + 1 && v != B_LAVA + 1) return v;
    }
    return 1;
}

/* Writes the nearest k remembered notable blocks of a class as x, y, z, class, tick rows. */
int view_notable(void *ap, int seat, int kind, int k, int32_t *out) {
    Mem *t = seat_mem(ap, seat);
    int order[NOTABLE_MAX], n = 0;
    int64_t dist[NOTABLE_MAX];
    for (int i = 0; i < t->nnotable; i++) {
        const Notable *e = &t->notable[i];
        if (kind >= 0 && e->kind != kind) continue;
        int64_t dx = e->x - t->cx, dy = e->y - t->cy, dz = e->z - t->cz, d = dx * dx + dy * dy + dz * dz;
        int j = n++;
        while (j > 0) {
            const Notable *q = &t->notable[order[j - 1]];
            int later = dist[j - 1] > d || (dist[j - 1] == d &&
                (q->x > e->x || (q->x == e->x && (q->y > e->y || (q->y == e->y && q->z > e->z)))));
            if (!later) break;
            dist[j] = dist[j - 1]; order[j] = order[j - 1]; j--;
        }
        dist[j] = d; order[j] = i;
    }
    if (n > k) n = k;
    for (int i = 0; i < n; i++) {
        const Notable *e = &t->notable[order[i]];
        out[5 * i] = e->x; out[5 * i + 1] = e->y; out[5 * i + 2] = e->z;
        out[5 * i + 3] = e->kind; out[5 * i + 4] = (int32_t)e->tick;
    }
    return n;
}

uint64_t view_digest(void *ap, int seat) {
    Mem *t = seat_mem(ap, seat);
    uint64_t h = 1469598103934665603ull;
    if (t->init) for (int i = 0; i < RING_BYTES; i++) { h ^= t->m[i]; h *= 1099511628211ull; }
    int32_t head[4] = {t->cx, t->cy, t->cz, t->nnotable};
    for (int i = 0; i < 4; i++) { h ^= (uint32_t)head[i]; h *= 1099511628211ull; }
    return h;
}

/* Counts remembered cells that are opaque and enclosed by opaque cells in the current world. */
uint32_t view_enclosed(void *ap, int seat) {
    Arena *a = ap;
    Mem *t = seat_mem(a, seat);
    uint32_t bad = 0;
    if (!t->init) return 0;
    for (int x = t->cx - 16; x < t->cx + 16; x++) for (int z = t->cz - 16; z < t->cz + 16; z++) for (int y = t->cy - 16; y < t->cy + 16; y++) {
        int v = t->m[ring_addr(x, y, z)];
        if (v < 2 || !in_world(a->b, x, y, z) || !(FLAGS[v - 1] & F_OPAQUE)) continue;
        int covered = 1;
        for (int i = 0; i < 6 && covered; i++) covered = sight_opaque(aget(a, x + DX6[i], y + DY6[i], z + DZ6[i]));
        if (covered) bad++;
    }
    return bad;
}

/* Updates every body from arrays ordered by arena, then seat. */
void see_many(void **arenas, int n, int seats, const double *eye, const double *yaw, const double *pitch, int r) {
    for (int i = 0; i < n; i++) for (int s = 0; s < seats; s++) {
        int k = i * seats + s;
        w_see(arenas[i], s, eye[3 * k], eye[3 * k + 1], eye[3 * k + 2], yaw[k], pitch[k], r);
    }
}

/* Writes one crop per body, ordered by arena, then seat. */
void crop_many(void **arenas, int n, int seats, uint8_t *out, int rx, int ry, int rz) {
    size_t size = (size_t)(2 * rx + 1) * (2 * ry + 1) * (2 * rz + 1);
    for (int i = 0; i < n; i++) for (int s = 0; s < seats; s++)
        view_crop(arenas[i], s, out + (size_t)(i * seats + s) * size, rx, ry, rz);
}

/* ---------- World cost benchmark ---------- */

static double now_ns(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e9 + t.tv_nsec;
}

/* Runs two bodies for the given decisions and returns microseconds per decision. Each decision
   has two ticks of collision, fluid and contact calls, world ticks, optional sight, crop and edits.
   When parts is given it receives microseconds per decision for collision, fluid and contact calls,
   world ticks, sight, crop and edits, at the small cost of reading the clock between them. */
double w_bench(void *ap, int decisions, int r, double sx, double sy, double sz, int edit_every, int bucket_every, int vis, double *parts) {
    Arena *a = ap;
    uint64_t x = 88172645463325252ull, sum = 0;
    double px[2] = {sx - 1.5, sx + 1.5}, py[2] = {sy, sy}, pz[2] = {sz, sz}, yaw[2] = {0, 180};
    uint8_t crop[11 * 7 * 11];
    int tick_no = 0, placed = 0, wet = 0, ex = ifloor(sx), ey = ifloor(sy), ez = ifloor(sz) + 2;
    double t = now_ns(), last = t;
#define MARK(I) do { if (parts) { double n_ = now_ns(); parts[I] += n_ - last; last = n_; } } while (0)
    if (parts) memset(parts, 0, 6 * sizeof(double));
    for (int d = 0; d < decisions; d++) {
        for (int k = 0; k < 2; k++) {
            for (int s = 0; s < 2; s++) {
                x ^= x << 13; x ^= x >> 7; x ^= x << 17;
                double mv[3] = {((double)(x & 255) / 255 - .5) * .4, -0.0784, ((double)((x >> 8) & 255) / 255 - .5) * .4};
                double pos[3] = {px[s], py[s], pz[s]}, out[3];
                uint8_t contact, ground;
                collide_one(a, pos, 0.6, 1.8, mv, 1, 0.6, out, &contact, &ground);
                px[s] = out[0] < sx - 3 ? sx - 3 : out[0] > sx + 3 ? sx + 3 : out[0];
                py[s] = out[1];
                pz[s] = out[2] < sz - 3 ? sz - 3 : out[2] > sz + 3 ? sz + 3 : out[2];
                MARK(0);
                double p2[3] = {px[s], py[s], pz[s]}, w = 0.6, h = 1.8, eh = 1.62, depth[2], flow[6];
                uint8_t ff, cf;
                int32_t cnt[2];
                void *one = a;
                fluid_box_many(&one, 1, 1, p2, &w, &h, &eh, &ff, depth, flow, cnt);
                contact_many(&one, 1, 1, p2, &w, &h, &cf);
                sum += ff + cf + contact + ground;
                MARK(1);
            }
            tick_no++;
            if (bucket_every && tick_no % bucket_every == 0) {
                wet = !wet;
                set_cell(a, ex, ey, ez + 1, wet ? mk_fluid(B_WATER, 8, 0) : (uint16_t)B_AIR);
            }
            w_tick(a, 1);
            MARK(2);
        }
        if (vis) {
            for (int s = 0; s < 2; s++) {
                x ^= x << 13; x ^= x >> 7; x ^= x << 17;
                yaw[s] += ((double)(x & 255) / 255 - .5) * 30;
                sum += w_see(a, s, px[s], py[s] + 1.62, pz[s], yaw[s], ((double)((x >> 8) & 255) / 255 - .5) * 60, r);
                MARK(3);
                view_crop(a, s, crop, 5, 3, 5);
                sum += crop[100];
                MARK(4);
            }
        }
        if (edit_every && d % edit_every == 0) {
            placed = !placed;
            set_cell(a, ex, ey, ez, placed ? (uint16_t)B_COBBLESTONE : (uint16_t)B_AIR);
            MARK(5);
        }
    }
#undef MARK
    t = now_ns() - t;
    if (parts) for (int i = 0; i < 6; i++) parts[i] /= decisions * 1000.0;
    return t / decisions / 1000.0 + (sum == 1 ? 1e-9 : 0);
}
