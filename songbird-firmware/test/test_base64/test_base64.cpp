/**
 * @file test_base64.cpp
 * @brief Native tests for base64 sleep-payload encode/decode round-trip (C3+C4)
 *
 * The sleep/wake state persistence path base64-encodes the raw SongbirdState
 * struct before handing it to card.attn (save side, C4) and base64-decodes it
 * on wake (restore side, C3). The struct is full of embedded 0x00 bytes, so a
 * correct codec MUST preserve every byte including NULs — the old code passed
 * the raw struct to JAddStringToObject() which truncated at the first NUL.
 *
 * These tests use a local copy of the note-c JB64 encoder/decoder (the exact
 * algorithm the firmware links against) to prove the round-trip is lossless
 * for binary data with embedded NULs and for a realistic state-sized buffer.
 */

#include <unity.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

// =============================================================================
// Local copy of note-c base64 codec (src/note-c/n_b64.c) — the exact algorithm
// the firmware uses. Kept in-file to avoid pulling in the Notecard hardware lib.
// =============================================================================

static const unsigned char pr2six[256] = {
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 62, 64, 64, 64, 63,
    52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 64, 64, 64, 64, 64, 64,
    64,  0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14,
    15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 64, 64, 64, 64, 64,
    64, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 64, 64, 64, 64, 64,
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64
};

static int JB64DecodeLen(const char *bufcoded) {
    int nbytesdecoded;
    const unsigned char *bufin;
    int nprbytes;
    bufin = (const unsigned char *) bufcoded;
    while (pr2six[*(bufin++)] <= 63);
    nprbytes = (int)((bufin - (const unsigned char *) bufcoded) - 1);
    nbytesdecoded = ((nprbytes + 3) / 4) * 3;
    return nbytesdecoded + 1;
}

static int JB64Decode(char *bufplain, const char *bufcoded) {
    int nbytesdecoded;
    const unsigned char *bufin;
    unsigned char *bufout;
    int nprbytes;
    bufin = (const unsigned char *) bufcoded;
    while (pr2six[*(bufin++)] <= 63);
    nprbytes = (int)((bufin - (const unsigned char *) bufcoded) - 1);
    nbytesdecoded = ((nprbytes + 3) / 4) * 3;
    bufout = (unsigned char *) bufplain;
    bufin = (const unsigned char *) bufcoded;
    while (nprbytes > 4) {
        *(bufout++) = (unsigned char)(pr2six[*bufin] << 2 | pr2six[bufin[1]] >> 4);
        *(bufout++) = (unsigned char)(pr2six[bufin[1]] << 4 | pr2six[bufin[2]] >> 2);
        *(bufout++) = (unsigned char)(pr2six[bufin[2]] << 6 | pr2six[bufin[3]]);
        bufin += 4;
        nprbytes -= 4;
    }
    if (nprbytes > 1) {
        *(bufout++) = (unsigned char)(pr2six[*bufin] << 2 | pr2six[bufin[1]] >> 4);
    }
    if (nprbytes > 2) {
        *(bufout++) = (unsigned char)(pr2six[bufin[1]] << 4 | pr2six[bufin[2]] >> 2);
    }
    if (nprbytes > 3) {
        *(bufout++) = (unsigned char)(pr2six[bufin[2]] << 6 | pr2six[bufin[3]]);
    }
    *(bufout++) = '\0';
    nbytesdecoded -= (4 - nprbytes) & 3;
    return nbytesdecoded;
}

static const char basis_64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int JB64EncodeLen(int len) {
    return ((len + 2) / 3 * 4) + 1;
}

static int JB64Encode(char *encoded, const char *string, int len) {
    int i;
    char *p = encoded;
    for (i = 0; i < len - 2; i += 3) {
        *p++ = basis_64[(string[i] >> 2) & 0x3F];
        *p++ = basis_64[((string[i] & 0x3) << 4) | ((int)(string[i + 1] & 0xF0) >> 4)];
        *p++ = basis_64[((string[i + 1] & 0xF) << 2) | ((int)(string[i + 2] & 0xC0) >> 6)];
        *p++ = basis_64[string[i + 2] & 0x3F];
    }
    if (i < len) {
        *p++ = basis_64[(string[i] >> 2) & 0x3F];
        if (i == (len - 1)) {
            *p++ = basis_64[((string[i] & 0x3) << 4)];
            *p++ = '=';
        } else {
            *p++ = basis_64[((string[i] & 0x3) << 4) | ((int)(string[i + 1] & 0xF0) >> 4)];
            *p++ = basis_64[((string[i + 1] & 0xF) << 2)];
        }
        *p++ = '=';
    }
    *p++ = '\0';
    return (int)(p - encoded);
}

// =============================================================================
// Helper mirroring the firmware save/restore round-trip
// =============================================================================

// Encode `len` raw bytes to a freshly-malloc'd base64 string (caller frees).
static char* encodePayload(const uint8_t* data, int len) {
    char* out = (char*)malloc((size_t)JB64EncodeLen(len));
    JB64Encode(out, (const char*)data, len);
    return out;
}

// Decode base64 back into `buffer` (bounded by bufferSize); returns bytes written.
static size_t decodePayload(const char* b64, uint8_t* buffer, size_t bufferSize) {
    size_t allocLen = (size_t)JB64DecodeLen(b64);
    uint8_t* tmp = (uint8_t*)malloc(allocLen);
    size_t actualLen = (size_t)JB64Decode((char*)tmp, b64);
    size_t copied = (actualLen <= bufferSize) ? actualLen : bufferSize;
    memcpy(buffer, tmp, copied);
    free(tmp);
    return copied;
}

void setUp(void) {}
void tearDown(void) {}

// =============================================================================
// Tests
// =============================================================================

// The core C4 regression: a buffer starting with 0x00 must survive the trip.
// The old JAddStringToObject((const char*)&s_state) truncated at the first NUL.
void test_leading_nul_byte_preserved(void) {
    uint8_t input[8] = {0x00, 0x01, 0x00, 0xFF, 0x00, 0x42, 0x00, 0x00};
    char* b64 = encodePayload(input, sizeof(input));

    uint8_t out[8];
    memset(out, 0xAA, sizeof(out));
    size_t n = decodePayload(b64, out, sizeof(out));

    TEST_ASSERT_EQUAL_UINT32(sizeof(input), n);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(input, out, sizeof(input));
    free(b64);
}

// Embedded NULs mid-buffer must not truncate the payload.
void test_embedded_nuls_roundtrip(void) {
    uint8_t input[16];
    for (int i = 0; i < 16; i++) input[i] = (uint8_t)((i % 3 == 0) ? 0x00 : (i * 7));
    char* b64 = encodePayload(input, sizeof(input));

    uint8_t out[16];
    size_t n = decodePayload(b64, out, sizeof(out));

    TEST_ASSERT_EQUAL_UINT32(sizeof(input), n);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(input, out, sizeof(input));
    free(b64);
}

// A realistic state-sized binary blob (all 256 byte values) round-trips exactly.
void test_full_byte_range_roundtrip(void) {
    uint8_t input[256];
    for (int i = 0; i < 256; i++) input[i] = (uint8_t)i;
    char* b64 = encodePayload(input, sizeof(input));

    // Encoded output must be a plain NUL-terminated ASCII string.
    TEST_ASSERT_EQUAL_size_t(strlen(b64), (size_t)(JB64EncodeLen(sizeof(input)) - 1));

    uint8_t out[256];
    size_t n = decodePayload(b64, out, sizeof(out));

    TEST_ASSERT_EQUAL_UINT32(sizeof(input), n);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(input, out, sizeof(input));
    free(b64);
}

// Encoded length matches the documented formula (used to size the malloc).
void test_encode_len_formula(void) {
    TEST_ASSERT_EQUAL_INT(5,  JB64EncodeLen(1));   // 1 byte -> 4 chars + NUL
    TEST_ASSERT_EQUAL_INT(5,  JB64EncodeLen(3));   // 3 bytes -> 4 chars + NUL
    TEST_ASSERT_EQUAL_INT(9,  JB64EncodeLen(4));   // 4 bytes -> 8 chars + NUL
    TEST_ASSERT_EQUAL_INT(89, JB64EncodeLen(64));  // 64 bytes -> 88 chars + NUL
}

// Decode into an undersized buffer must be bounded (no overflow) — mirrors the
// notecardGetSleepPayload() clamp to bufferSize.
void test_decode_bounded_by_buffer_size(void) {
    uint8_t input[32];
    for (int i = 0; i < 32; i++) input[i] = (uint8_t)(i + 1);
    char* b64 = encodePayload(input, sizeof(input));

    uint8_t out[8];
    size_t n = decodePayload(b64, out, sizeof(out));

    TEST_ASSERT_EQUAL_UINT32(sizeof(out), n);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(input, out, sizeof(out));
    free(b64);
}

int main(int argc, char **argv) {
    (void)argc; (void)argv;
    UNITY_BEGIN();
    RUN_TEST(test_leading_nul_byte_preserved);
    RUN_TEST(test_embedded_nuls_roundtrip);
    RUN_TEST(test_full_byte_range_roundtrip);
    RUN_TEST(test_encode_len_formula);
    RUN_TEST(test_decode_bounded_by_buffer_size);
    return UNITY_END();
}
